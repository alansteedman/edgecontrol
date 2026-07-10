#!/usr/bin/env python3
"""CC1101 frequency scanner — find which frequency the Tremblr remote uses.

Keep pressing the remote button repeatedly during each test.
The frequency with the highest peak RSSI is the one the remote uses.
"""

import lgpio
import time

_gpio = lgpio.gpiochip_open(0)

CC_CS   = 16
CC_CLK  = 21
CC_MOSI = 20
CC_MISO = 17

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

def read_status(addr):
    _w(CC_CS, 0); _wait_ready()
    _spi_byte(addr | 0xC0)
    val = _spi_byte(0x00)
    _w(CC_CS, 1)
    return val

def read_rssi():
    raw = read_status(0x34)
    if raw >= 128:
        return (raw - 256) / 2 - 74
    return raw / 2 - 74

def freq_regs(hz):
    word = int(hz * 65536 / 26e6)
    return (word >> 16) & 0xFF, (word >> 8) & 0xFF, word & 0xFF

def configure_rx(freq_hz):
    strobe(0x30); time.sleep(0.02)   # reset
    write_reg(0x02, 0x0D)            # IOCFG0 - carrier sense on GDO0
    write_reg(0x08, 0x00)            # PKTCTRL0 - infinite packet length, no CRC
    write_reg(0x0B, 0x06)            # FSCTRL1
    f2, f1, f0 = freq_regs(freq_hz)
    write_reg(0x0D, f2)              # FREQ2
    write_reg(0x0E, f1)              # FREQ1
    write_reg(0x0F, f0)              # FREQ0
    write_reg(0x10, 0xC7)            # MDMCFG4 - BW 325 kHz
    write_reg(0x11, 0x83)            # MDMCFG3 - ~3.8 kBaud
    write_reg(0x12, 0x3B)            # MDMCFG2 - OOK, no sync word
    write_reg(0x15, 0x00)            # DEVIATN
    write_reg(0x18, 0x18)            # MCSM0
    write_reg(0x1B, 0x43)            # AGCCTRL2 - OOK optimised
    write_reg(0x1C, 0x40)            # AGCCTRL1
    write_reg(0x1D, 0x91)            # AGCCTRL0
    write_reg(0x21, 0x56)            # FREND1
    write_reg(0x22, 0x11)            # FREND0 - OOK PA table
    write_reg(0x23, 0xE9)            # FSCAL3
    write_reg(0x24, 0x2A)            # FSCAL2
    write_reg(0x25, 0x00)            # FSCAL1
    write_reg(0x26, 0x1F)            # FSCAL0
    strobe(0x34)                     # SRX - enter receive mode

# Frequencies to scan (MHz) — covers CC1101 band 1 and band 2
SCAN_FREQS = [
    313.00e6,
    315.00e6,
    318.00e6,
    345.00e6,
    390.00e6,
    418.00e6,
    433.92e6,
    434.08e6,
    440.00e6,
]

print("CC1101 Frequency Scanner")
print("=" * 50)
print("Keep pressing the Tremblr remote button")
print("repeatedly during EACH 3-second test.")
print()

results = []
for freq in SCAN_FREQS:
    configure_rx(freq)
    time.sleep(0.05)
    label = f"{freq/1e6:.2f} MHz"
    print(f"Testing {label}... press button now!", end=" ", flush=True)
    peak = -120.0
    t_end = time.monotonic() + 3.0
    while time.monotonic() < t_end:
        rssi = read_rssi()
        if rssi > peak:
            peak = rssi
        time.sleep(0.005)
    results.append((freq, peak))
    print(f"peak {peak:.0f} dBm")

strobe(0x36)  # SIDLE
lgpio.gpiochip_close(_gpio)

print()
print("Results:")
print("-" * 50)
results.sort(key=lambda x: -x[1])
best_rssi = results[0][1]
for freq, rssi in results:
    bar = "█" * max(0, int((rssi + 100) / 2))
    marker = "  ← LIKELY MATCH" if rssi == best_rssi else ""
    print(f"  {freq/1e6:.2f} MHz  {rssi:>6.1f} dBm  {bar}{marker}")

print()
print(f"Most likely frequency: {results[0][0]/1e6:.2f} MHz")
