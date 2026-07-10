#!/usr/bin/env python3
"""CC1101 SPI comms test — verifies chip is wired and responding correctly."""

import lgpio
import time

_gpio = lgpio.gpiochip_open(0)

# CC1101 pins
CC_CS   = 16   # GPIO16 = Pin 36
CC_CLK  = 21   # GPIO21 = Pin 40
CC_MOSI = 20   # GPIO20 = Pin 38
CC_MISO = 17   # GPIO17 = Pin 11

def _out(pin, val=0): lgpio.gpio_claim_output(_gpio, pin, val)
def _inp(pin):        lgpio.gpio_claim_input(_gpio, pin)
def _w(pin, val):     lgpio.gpio_write(_gpio, pin, val)
def _r(pin):          return lgpio.gpio_read(_gpio, pin)

_out(CC_CS, 1)
_out(CC_CLK, 0)
_out(CC_MOSI, 0)
_inp(CC_MISO)

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
            raise TimeoutError("CC1101 MISO did not go low — check VCC and wiring")

def strobe(cmd):
    _w(CC_CS, 0)
    _wait_ready()
    _spi_byte(cmd)
    _w(CC_CS, 1)

def read_reg(addr):
    _w(CC_CS, 0)
    _wait_ready()
    _spi_byte(addr | 0x80)   # read bit
    val = _spi_byte(0x00)
    _w(CC_CS, 1)
    return val

def read_status(addr):
    _w(CC_CS, 0)
    _wait_ready()
    _spi_byte(addr | 0xC0)   # read + burst for status registers
    val = _spi_byte(0x00)
    _w(CC_CS, 1)
    return val

print("CC1101 comms test")
print("-" * 30)

# Reset chip
print("Sending reset strobe (SRES)...")
strobe(0x30)
time.sleep(0.01)

# Read chip ID registers
partnum = read_status(0x30)
version = read_status(0x31)

print(f"PARTNUM : 0x{partnum:02X}  (expect 0x00)")
print(f"VERSION : 0x{version:02X}  (expect 0x14)")

if partnum == 0x00 and version == 0x14:
    print("\nCC1101 detected OK!")
else:
    print("\nUnexpected values — check wiring")
    print("MISO stuck high usually means VCC or GND problem")
    print("0xFF on both usually means MOSI/CLK/CS wiring issue")

lgpio.gpiochip_close(_gpio)
