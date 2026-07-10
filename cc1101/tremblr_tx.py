#!/usr/bin/env python3
"""CC1101 Tremblr RF transmitter daemon.

Reads commands from stdin (one per line), sends RCSwitch protocol 1
OOK packets at 315 MHz. Outputs 'ready' on startup, 'ok:<cmd>' after
each successful send, 'err:<msg>' on failure.
"""

import lgpio
import time
import sys
import threading
import queue as Q

_gpio = lgpio.gpiochip_open(0)

CC_CS   = 16   # GPIO16 = Pin 36
CC_CLK  = 21   # GPIO21 = Pin 40
CC_MOSI = 20   # GPIO20 = Pin 38
CC_MISO = 17   # GPIO17 = Pin 11

def _out(pin, val=0): lgpio.gpio_claim_output(_gpio, pin, val)
def _inp(pin):        lgpio.gpio_claim_input(_gpio, pin)
def _w(pin, val):     lgpio.gpio_write(_gpio, pin, val)
def _r(pin):          return lgpio.gpio_read(_gpio, pin)

_out(CC_CS, 1); _out(CC_CLK, 0); _out(CC_MOSI, 0); _inp(CC_MISO)

def _spi_byte(b):
    result = 0
    for i in range(8):
        _w(CC_MOSI, (b >> (7 - i)) & 1)
        _w(CC_CLK, 1)
        result = (result << 1) | _r(CC_MISO)
        _w(CC_CLK, 0)
    return result

def _wait_ready():
    t = time.monotonic()
    while _r(CC_MISO):
        if time.monotonic() - t > 0.1:
            raise TimeoutError("CC1101 not ready")

def strobe(cmd):
    _w(CC_CS, 0); _wait_ready(); _spi_byte(cmd); _w(CC_CS, 1)

def write_reg(addr, val):
    _w(CC_CS, 0); _wait_ready()
    _spi_byte(addr & 0x3F)
    _spi_byte(val)
    _w(CC_CS, 1)

def write_burst(addr, data):
    _w(CC_CS, 0); _wait_ready()
    _spi_byte((addr & 0x3F) | 0x40)
    for b in data:
        _spi_byte(b)
    _w(CC_CS, 1)

def read_status(addr):
    _w(CC_CS, 0); _wait_ready()
    _spi_byte(addr | 0xC0)
    val = _spi_byte(0x00)
    _w(CC_CS, 1)
    return val

# ── Tremblr command codes (RCSwitch 24-bit) ───────────────────────────────────
CODES = {
    'faster':    16076992,   # speed up one step
    'slower':    16076848,   # speed down one step
    'startstop': 16076812,   # toggle on/off
    'air_out':   16076803,   # release air
    'air_in':    16077568,   # inflate
}

def encode_packet(code, bits=24):
    """Encode as RCSwitch protocol 1 OOK sub-bits for the TX FIFO.

    At 1984 baud, T ≈ 504μs per sub-bit.
      0 bit  = [1,0,0,0]     1T high + 3T low
      1 bit  = [1,1,1,0]     3T high + 1T low
      sync   = 1T high + 31T low  (32 sub-bits)
    Total: 32 + 24×4 = 128 sub-bits = 16 bytes.
    """
    subs = [1] + [0] * 31
    for i in range(bits - 1, -1, -1):
        if (code >> i) & 1:
            subs += [1, 1, 1, 0]
        else:
            subs += [1, 0, 0, 0]
    packet = []
    for i in range(0, len(subs), 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | (subs[i + j] if i + j < len(subs) else 0)
        packet.append(byte)
    return packet

def configure_tx():
    strobe(0x30); time.sleep(0.02)   # SRES

    # Frequency: 315.00 MHz
    write_reg(0x0D, 0x0C)
    write_reg(0x0E, 0x1D)
    write_reg(0x0F, 0x89)

    # Modem: OOK, 1984 baud → T ≈ 504μs
    write_reg(0x10, 0x86)   # MDMCFG4: BW 203kHz, DRATE_E=6
    write_reg(0x11, 0x40)   # MDMCFG3: DRATE_M=64
    write_reg(0x12, 0x30)   # MDMCFG2: OOK, no sync, no preamble
    write_reg(0x13, 0x00)   # MDMCFG1: no FEC

    # Packet: fixed 16 bytes, no CRC
    write_reg(0x06, 0x10)   # PKTLEN = 16
    write_reg(0x08, 0x00)   # PKTCTRL0: fixed length, no CRC
    write_reg(0x07, 0x00)   # PKTCTRL1: no status byte

    # State machine: go IDLE after TX
    write_reg(0x17, 0x00)   # MCSM1: TXOFF=IDLE
    write_reg(0x18, 0x18)   # MCSM0: default

    # PA table: [off, max power for 315 MHz]
    write_burst(0x3E, [0x00, 0xC0])

    # Front end: OOK, use 2 PA table entries (0=off, 1=on)
    write_reg(0x22, 0x11)   # FREND0

    # Frequency calibration
    write_reg(0x23, 0xE9)
    write_reg(0x24, 0x2A)
    write_reg(0x25, 0x00)
    write_reg(0x26, 0x1F)

    strobe(0x36)   # SIDLE

def send_code(code, repeat=10):
    packet = encode_packet(code)
    for _ in range(repeat):
        strobe(0x3B)                  # SFTX - flush TX FIFO
        write_burst(0x3F, packet)     # load TX FIFO (0x3F = TX FIFO)
        strobe(0x35)                  # STX - transmit
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            if (read_status(0x35) & 0x1F) == 0x01:   # MARCSTATE = IDLE
                break
            time.sleep(0.005)

# ── Main ─────────────────────────────────────────────────────────────────────
# Two-queue design: hi_q for startstop/air (preempts), lo_q for faster/slower
# Only the main thread touches GPIO — the reader thread only queues.

hi_q = Q.Queue()   # startstop, air_in, air_out — processed first
lo_q = Q.Queue()   # faster, slower — can be flushed

PRIORITY = {'startstop', 'air_in', 'air_out', 'ping'}

def _reader():
    for line in sys.stdin:
        parts = line.strip().split()
        if not parts:
            continue
        cmd, repeat = parts[0], (int(parts[1]) if len(parts) > 1 else 10)
        if cmd in PRIORITY:
            hi_q.put((cmd, repeat))
        elif cmd == 'clear':
            while not lo_q.empty():
                try: lo_q.get_nowait()
                except Q.Empty: break
        elif cmd in CODES:
            lo_q.put((cmd, repeat))

configure_tx()
threading.Thread(target=_reader, daemon=True).start()
sys.stdout.write('ready\n')
sys.stdout.flush()

while True:
    try:
        cmd, repeat = hi_q.get_nowait()
    except Q.Empty:
        try:
            cmd, repeat = lo_q.get(timeout=0.05)
        except Q.Empty:
            continue
    if cmd == 'ping':
        sys.stdout.write('pong\n'); sys.stdout.flush(); continue
    if cmd in CODES:
        try:
            send_code(CODES[cmd], repeat=repeat)
            sys.stdout.write(f'ok:{cmd}\n')
        except Exception as e:
            sys.stdout.write(f'err:{e}\n')
        sys.stdout.flush()

strobe(0x36)
lgpio.gpiochip_close(_gpio)
