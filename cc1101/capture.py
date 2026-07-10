#!/usr/bin/env python3
"""CC1101 signal capture — record Tremblr remote button patterns.

Captures raw OOK pulse timing for each button and saves to tremblr_codes.json.
"""

import lgpio
import time
import json

_gpio = lgpio.gpiochip_open(0)

CC_CS   = 16
CC_CLK  = 21
CC_MOSI = 20
CC_MISO = 17
GDO0    = 18   # GPIO18 = Pin 12 — carrier sense output

def _out(pin, val=0): lgpio.gpio_claim_output(_gpio, pin, val)
def _inp(pin):        lgpio.gpio_claim_input(_gpio, pin)
def _w(pin, val):     lgpio.gpio_write(_gpio, pin, val)
def _r(pin):          return lgpio.gpio_read(_gpio, pin)

_out(CC_CS, 1); _out(CC_CLK, 0); _out(CC_MOSI, 0)
_inp(CC_MISO); _inp(GDO0)

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
    _spi_byte(addr & 0x3F); _spi_byte(val)
    _w(CC_CS, 1)

def configure_rx():
    strobe(0x30); time.sleep(0.02)
    write_reg(0x02, 0x0D)   # IOCFG0 - carrier sense on GDO0
    write_reg(0x08, 0x00)   # PKTCTRL0 - infinite packet length
    write_reg(0x0B, 0x06)   # FSCTRL1
    write_reg(0x0D, 0x0C)   # FREQ2 — 315 MHz
    write_reg(0x0E, 0x1D)   # FREQ1
    write_reg(0x0F, 0x89)   # FREQ0
    write_reg(0x10, 0xC7)   # MDMCFG4 - BW 325 kHz
    write_reg(0x11, 0x83)   # MDMCFG3 - ~3.8 kBaud
    write_reg(0x12, 0x3B)   # MDMCFG2 - OOK, no sync word
    write_reg(0x15, 0x00)   # DEVIATN
    write_reg(0x18, 0x18)   # MCSM0
    write_reg(0x1B, 0x43)   # AGCCTRL2 - OOK
    write_reg(0x1C, 0x40)   # AGCCTRL1
    write_reg(0x1D, 0x91)   # AGCCTRL0
    write_reg(0x21, 0x56)   # FREND1
    write_reg(0x22, 0x11)   # FREND0 - OOK PA table
    write_reg(0x23, 0xE9)   # FSCAL3
    write_reg(0x24, 0x2A)   # FSCAL2
    write_reg(0x25, 0x00)   # FSCAL1
    write_reg(0x26, 0x1F)   # FSCAL0
    strobe(0x34)             # SRX

def capture_pulses(timeout=3.0, gap_ms=100):
    """Record OOK pulse train. Returns list of (level, duration_us).
    Stops after gap_ms of silence following at least one pulse."""
    pulses = []
    seen_signal = False
    last_signal_t = None

    last_state = _r(GDO0)
    last_t = time.monotonic()
    start = last_t

    while True:
        now = time.monotonic()
        state = _r(GDO0)

        if state != last_state:
            dt_us = int((now - last_t) * 1e6)
            pulses.append((last_state, dt_us))
            if state == 1:
                seen_signal = True
                last_signal_t = now
            last_state = state
            last_t = now
        else:
            if state == 1:
                seen_signal = True
                last_signal_t = now

        if seen_signal and last_signal_t and (now - last_signal_t) > gap_ms / 1000:
            break
        if now - start > timeout:
            break

    return pulses

def summarise(pulses):
    highs = [d for s, d in pulses if s == 1]
    lows  = [d for s, d in pulses if s == 0]
    total = sum(d for _, d in pulses)
    return {
        "pulse_count": len(pulses),
        "high_pulses": len(highs),
        "low_pulses": len(lows),
        "total_us": total,
        "avg_high_us": int(sum(highs) / len(highs)) if highs else 0,
        "avg_low_us":  int(sum(lows)  / len(lows))  if lows  else 0,
        "min_high_us": min(highs) if highs else 0,
        "max_high_us": max(highs) if highs else 0,
    }

def visualise(pulses, width=60):
    """Print a simple ASCII waveform of the first portion."""
    significant = [(s, d) for s, d in pulses if d > 50][:40]
    if not significant:
        return "  (no signal)"
    total = sum(d for _, d in significant)
    chars = []
    for state, dur in significant:
        n = max(1, int(dur / total * width))
        chars.append("█" * n if state else "░" * n)
    return "  " + "".join(chars)

# ── Main ─────────────────────────────────────────────────────────────────────

BUTTON_NAMES = ["Button 1", "Button 2", "Button 3", "Button 4", "Button 5"]
results = {}

print("Tremblr Remote Capture")
print("=" * 50)
configure_rx()
print("CC1101 ready at 315 MHz OOK\n")

for name in BUTTON_NAMES:
    input(f"→ Press ENTER, then immediately hold {name}...")
    print("  Listening...", end=" ", flush=True)

    pulses = capture_pulses(timeout=3.0, gap_ms=150)

    highs = [d for s, d in pulses if s == 1]
    if not highs:
        print("NO SIGNAL — check GDO0 wiring (GPIO18 / Pin 12)")
        results[name] = {"pulses": [], "error": "no_signal"}
        continue

    stats = summarise(pulses)
    print(f"captured {stats['pulse_count']} pulses over {stats['total_us']//1000} ms")
    print(visualise(pulses))
    print(f"  high avg {stats['avg_high_us']}μs  low avg {stats['avg_low_us']}μs")
    print()

    results[name] = {
        "pulses": pulses,
        "stats": stats
    }

strobe(0x36)  # SIDLE
lgpio.gpiochip_close(_gpio)

# Save
with open("/home/alans/cc1101/tremblr_codes.json", "w") as f:
    json.dump(results, f, indent=2)

print("Saved to /home/alans/cc1101/tremblr_codes.json")
print()
print("Summary:")
for name, data in results.items():
    if "error" in data:
        print(f"  {name}: FAILED")
    else:
        s = data["stats"]
        print(f"  {name}: {s['pulse_count']} pulses, {s['total_us']//1000}ms, "
              f"high={s['avg_high_us']}μs low={s['avg_low_us']}μs")
