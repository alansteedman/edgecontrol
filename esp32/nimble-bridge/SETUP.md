# NimbleBridge ESP32 Setup

The ESP32 sits between the Pi and the NimbleStroker. It connects to your WiFi
and exposes a TCP server on port 8765. The Pi talks to it over TCP instead of
USB serial — the 7-byte binary protocol is identical.

```
Pi ──WiFi──► TCP:8765 ──► ESP32 ──UART 115200──► NimbleStroker (RJ12)
          ◄── feedback ◄──       ◄── UART ───────
```

---

## Step 1 — Install tools on your Mac

Open Terminal and run:

```bash
pip3 install esptool mpremote
```

---

## Step 2 — Identify your chip

Plug the ESP32 board in via USB-C. Then run:

```bash
esptool.py chip_id
```

Look for a line like `Chip is ESP32` or `Chip is ESP32-S3`.
Note this — you need the right MicroPython firmware file for your chip.

Also note the port it appears on:

```bash
ls /dev/cu.*
```

You'll see something like `/dev/cu.usbserial-0001` or `/dev/cu.SLAB_USBtoUART`.

---

## Step 3 — Download MicroPython firmware

Go to https://micropython.org/download/ and download the latest stable `.bin`
for your chip:

- **ESP32** (standard) → search "ESP32" → download `ESP32_GENERIC-vX.X.X.bin`
- **ESP32-S3** → search "ESP32-S3" → download `ESP32_GENERIC_S3-vX.X.X.bin`

---

## Step 4 — Flash MicroPython

Replace `/dev/cu.usbserial-XXXX` with your actual port and the filename with
what you downloaded:

```bash
# Erase first (important — clears any old firmware)
esptool.py --port /dev/cu.usbserial-XXXX erase_flash

# Flash MicroPython
esptool.py --port /dev/cu.usbserial-XXXX --baud 460800 write_flash -z 0x1000 ESP32_GENERIC-vX.X.X.bin
```

For ESP32-S3, the flash offset is `0x0` not `0x1000`:

```bash
esptool.py --port /dev/cu.usbserial-XXXX --baud 460800 write_flash -z 0x0 ESP32_GENERIC_S3-vX.X.X.bin
```

---

## Step 5 — Test MicroPython is running

```bash
mpremote connect /dev/cu.usbserial-XXXX
```

You should get a `>>>` Python prompt. Type `print("hello")` to confirm.
Press Ctrl+X or Ctrl+] to exit.

---

## Step 6 — Wiring

### Power
The RJ12 pin 1 carries 12V. Run this through a 12V→5V buck converter and
connect the 5V output to the ESP32's 5V/VIN pin.

Connect RJ12 GND to ESP32 GND (same GND as buck converter output).

### UART
The NimbleStroker sends and receives 3.3V TTL serial — compatible with ESP32.
Cross-connect TX↔RX:

| RJ12 pin | Signal       | ESP32 pin |
|----------|--------------|-----------|
| (your TX)| Nimble TX out| GPIO16 (RX2) |
| (your RX)| Nimble RX in | GPIO17 (TX2) |
| GND      | GND          | GND       |

**Update `TX_PIN` and `RX_PIN` in `main.py`** if your confirmed pinout uses
different ESP32 GPIOs.

---

## Step 7 — Upload the firmware files

```bash
# Copy all three files to the ESP32
mpremote connect /dev/cu.usbserial-XXXX cp boot.py :boot.py
mpremote connect /dev/cu.usbserial-XXXX cp main.py :main.py
```

---

## Step 8 — First boot (AP mode)

The ESP32 has no WiFi credentials yet, so it will start an access point:

- **SSID:** `NimbleBridge-Setup`
- **Password:** `nimble123`

On your phone or laptop, connect to that network, then open a browser and go to:

```
http://192.168.4.1
```

Enter your home WiFi SSID and password, hit Save. The ESP32 will restart and
connect to your network. The IP address it gets will be shown over the serial
monitor (see below).

---

## Step 9 — Find the ESP32's IP

```bash
mpremote connect /dev/cu.usbserial-XXXX
```

The boot log will show something like:

```
[boot] Connected — IP: 192.168.1.42
[main] Bridge ready — connect Pi to 192.168.1.42:8765
```

Note that IP — you'll enter it in the Pi's device config.

**Tip:** Give the ESP32 a static IP in your router's DHCP settings (reserve by
MAC address) so it never changes.

---

## Step 10 — Add to EdgeController

In the EdgeController web UI, go to **Config → Add Device → Nimble**.
Instead of a USB serial port, enter the TCP address:

```
tcp://192.168.1.42:8765
```

(The server.js update to support TCP is a separate step — see `TCP_CHANGES.md`.)

---

## Monitoring / troubleshooting

Watch the live log from the ESP32:

```bash
mpremote connect /dev/cu.usbserial-XXXX
```

You'll see `[bridge] Pi connected from 192.168.1.69` when the Pi connects,
and `[bridge] Pi disconnected` when it drops.

To reset WiFi credentials (e.g. moving to a new network):

```bash
mpremote connect /dev/cu.usbserial-XXXX
>>> import os; os.remove('wifi.json')
>>> import machine; machine.reset()
```

This puts it back into AP setup mode.
