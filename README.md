# EdgeController

A self-hosted BLE and USB device controller that runs on a Raspberry Pi 5. Provides a web UI for managing connected devices, building automated macro sequences, and integrating physical input devices.

## Features

- **Web UI** — accessible on your local network via `http://<device-id>.local:3000`
- **Visual macro editor** — node-based flow editor for building automated sequences with delays, ramps, conditionals, loops, and sensor waits
- **StreamDeck+ integration** — hardware buttons, encoders and LCD for running and controlling macros
- **BLE device management** — automatic reconnection with backoff
- **Remote access** — optional Cloudflare tunnel for access outside your local network
- **WiFi onboarding** — AP mode with captive portal for initial WiFi setup

## Supported Devices

| Device | Type | Connection |
|--------|------|------------|
| DG-Lab Coyote | Haptic/E-stim | BLE |
| DG-Lab PawPrints (47L120100) | Motion sensor / buttons | BLE |
| E-Stim 2B | E-stim | USB Serial |
| Nimble | Motor | USB Serial or WiFi (NimbleBridge ESP32) |
| EOM | Arousal sensor | Network |
| IP Camera | Video | Network |
| Philips Hue | Smart lighting | Network (local bridge) |
| Shelly Gen 3/4 | Relay / dimmer | Network (WiFi) + BLE provisioning |
| Tremblr | Vibrator | RF 315MHz (CC1101) |

## Macro Blocks

The visual macro editor supports the following block types:

**Control** — Start, End, Stop All, Run Macro

**Timing** — Delay

**Nimble** — Nimble Start (set speed/depth/nurture/nature and start stroke), Nimble Stop, Nimble Ramp (ramp Speed/Depth/Nurture/Nature over time)

**Coyote** — Coyote Ramp (smooth intensity transition over time), Set (waveform, intensity, speed per channel)

**E-Stim** — E-Stim Ramp (ramp power on A/B/Both over time), Set (mode/waveform, power per channel)

**Hue** — Set Hue (activate a scene or room at a set brightness), Hue Ramp (smoothly ramp brightness from x% to y% over time)

**I/O** — Switch (toggle Shelly relay on/off), Light (toggle Shelly dimmer on/off)

**Triggers** — Wait: EOM (pause until arousal threshold), Wait: Manual (pause until user clicks continue), Wait: Paw (pause until PawPrints button press or tilt angle)

**Logic** — If/Else (branch on EOM arousal), Paw: If/Else (branch on PawPrints button or tilt), Loop

## Hardware Requirements

- Raspberry Pi 5 (tested on 4GB and 8GB)
- Ubuntu 24.04 LTS (recommended) or Raspberry Pi OS
- Bluetooth adapter (built-in on Pi 5)
- Elgato StreamDeck+ (optional)

## Installation

Run this on a fresh Pi with Ubuntu installed:

```bash
curl -fsSL https://raw.githubusercontent.com/alansteedman/edgecontrol/main/install.sh | sudo bash
```

Then reboot:

```bash
sudo reboot
```

After reboot, open `http://<device-id>.local:3000` in your browser. The device ID is printed at the end of the install script output and is derived from the Pi's CPU serial number.

## WiFi Setup

If you need to connect the Pi to WiFi after a fresh install, the device will broadcast a `EdgeController-Setup` hotspot. Connect to it, open any webpage, and you'll be redirected to the WiFi setup page. Enter your network credentials and the device will connect and restart.

## Touchscreen UI

The `touchscreen/` directory contains a Python UI for an ILI9341 320×240 TFT with XPT2046 touch controller, giving the Pi a standalone interface without needing a browser.

### Screens

- **Status** — shows WiFi SSID, IP address, Cloudflare tunnel URL and external URL; tap "WiFi Setup" to change network
- **Scan** — scans for nearby networks via NetworkManager
- **SSID list** — scrollable list of networks with signal strength and security; tap to select, "← Back" to cancel
- **Password** — on-screen keyboard (lower/upper/symbols); "← Back" returns to SSID list
- **Confirm** — shows network name before connecting; Cancel or Connect
- **Result** — success (IP shown) or failure message

### Hardware

| Component | Detail |
|-----------|--------|
| Display | ILI9341 320×240 TFT, hardware SPI0 (CE0), DC=GPIO24, RST=GPIO25 |
| Touch | XPT2046, software SPI: CS=GPIO5, CLK=GPIO6, DIN=GPIO13, DO=GPIO19, IRQ=GPIO26 |
| Orientation | Landscape, 180° rotation (MADCTL=0xE8) |

### Dependencies

```bash
pip3 install spidev lgpio numpy Pillow
```

### Running

The touchscreen starts automatically at boot via systemd:

```bash
systemctl status touchscreen.service
journalctl -u touchscreen.service -f
```

To run manually:

```bash
python3 /home/alans/touchscreen/touchscreen.py
```

### Touch calibration

Run this if taps don't register in the right place (outputs new `TOUCH_X_MIN/MAX` and `TOUCH_Y_MIN/MAX` constants):

```bash
python3 /home/alans/touchscreen/touchscreen.py calibrate
```

## NimbleBridge (ESP32 WiFi Adapter)

The `esp32/nimble-bridge/` directory contains MicroPython firmware for an ESP32-WROOM-32 that bridges the NimbleStroker over WiFi, removing the need for a USB cable to the Pi.

### How it works

- On first boot the ESP32 broadcasts a `NimbleBridge-Setup` hotspot
- Connect to it, open `192.168.4.1` in a browser, and enter your home WiFi credentials
- After reboot the ESP32 connects to your network and displays its IP on the built-in TFT screen
- The Pi discovers it automatically via **Add Device → NimbleStroker → WiFi Bridge → Scan**
- Once connected, the Pi sends oscillation parameters (speed, depth, nurture, nature) to the ESP32 over TCP port 8765
- The ESP32 runs the sine-wave oscillation **locally** at a hard 20ms tick and drives the NimbleStroker over UART — WiFi jitter never affects motion smoothness
- Force is auto-calculated from speed × depth: `force = clamp(100 + 0.08 × speed_hz × depth, 100, 900)`

### Standalone web UI

The ESP32 also serves a control page at `http://<esp32-ip>/` — identical controls to the Pi UI (Run, Speed, Depth, Nurture, Nature, Air In/Out, live feedback) so you can use the NimbleStroker from any phone or browser without the Pi.

### Hardware

- ESP32-WROOM-32 dev board
- ST7789 170×320 TFT display (SPI)
- NimbleStroker connected via UART2 (TX=GPIO17, RX=GPIO16)
- MicroPython v1.28.0 — router must be set to **WPA2** (not WPA1)

### Flashing

```bash
# Erase and flash MicroPython v1.28.0
esptool.py --chip esp32 erase_flash
esptool.py --chip esp32 write_flash -z 0x1000 ESP32_GENERIC-20260406-v1.28.0.bin

# Upload firmware files
cd esp32/nimble-bridge
mpremote connect /dev/cu.usbserial-XXX cp boot.py :boot.py
mpremote connect /dev/cu.usbserial-XXX cp main.py :main.py
mpremote connect /dev/cu.usbserial-XXX cp display.py :display.py
mpremote connect /dev/cu.usbserial-XXX reset
```

## Versions

- **v2.1.6** — Device authorisation system: Pis must be approved by an admin before running; Fleet tab shows Pending/Authorised/Revoked status per device with approve/revoke controls; revocation takes effect immediately if the Pi is online; lockout mode disables the web UI and shows a "Not Authorised" screen on the touchscreen
- **v2.1.5** — Stream Deck: activities (Lick, Throb, Wave, Penetration, Climb, Flutter, Tease, Heartbeat) now appear in the waveform picker after the built-in waveforms, rendered in amber with their icon; selecting an activity puts the channel into activity mode; channel and group LCD strips show the activity name when active; Waveforms tab: Activities section added showing all 8 activities with icon and description; Stream Deck visibility checkbox on every item in the Waveforms tab (built-in waveforms, activities, custom waveforms, audio files) — uncheck to hide from the Stream Deck picker, checked by default; touchscreen display sleep now fills the screen black before sending SLPIN so the panel appears off even though the backlight stays on
- **v2.1.4** — AP mode hotspot button on touchscreen: tap AP Mode to start a named hotspot (EdgeController-{boxId}, password: edgesetup, URL: 10.42.0.1:3000) so users can connect directly without a WiFi network; tap Exit Hotspot to stop and reconnect to the previous WiFi automatically; status screen shows two buttons (AP Mode / WiFi Setup) or a single Exit Hotspot button when already in hotspot mode; auto-update fix: page reloads itself after update restarts the server; Safari keep-alive fix: 65s keepAliveTimeout prevents 3-minute hang on refresh after server restart
- **v2.1.3** — Activities: eight built-in generative patterns (Lick, Throb, Wave, Penetration, Climb, Flutter, Tease, Heartbeat) each run two independent waveforms simultaneously — one controlling amplitude, one controlling frequency — with two out-of-phase sine oscillators continuously drifting ampSpeed and freqSpeed so the sensation evolves indefinitely without repeating; channel and group canvases show the amp wave in gold when an activity is active; fixed the classic 'wave' waveform feeling like distinct pulses (was applying a π/2 phase offset across the four sub-pulses within each 25ms BLE packet, creating perceptible amplitude steps; now all four sub-pulses use the same amplitude per packet); freq slider now matches intensity slider in length and colour (yellow); intensity value moved to right end of its slider row
- **v2.1.2** — Coyote frequency raised to 200Hz across all sliders, waveform designer, and live audio (was capped at 100Hz); HWL waveform import: parse Howl's binary .hwl format and import as two waveforms (channel A and B) directly from the Waveforms tab; auto-update: Pi checks GitHub on startup and every 4 hours, shows a dismissible banner when a newer version is available with an info button that displays the changelog for the new version, Update now button runs git pull + npm install + pm2 restart on git-based installs
- **v2.1.1** — Custom Stream Deck+ layout: user-configurable button and encoder pages built in the web UI, drag-and-drop palette grouped by device type (Buttons: Waveforms/Macros/Actions; Knobs: Coyote/Nimble/Hue/E-Stim/Shelly), type enforcement prevents dropping knob assignments onto button slots and vice versa, live pixel-identical rendering on device matching native pages (coyote arc dial, encoder LCD strip, waveform picker buttons), coyote intensity/speed share one encoder (press to toggle), coyote group support applies to all channels simultaneously, dynamic Hue room and E-Stim per-unit/channel palette items, encoder pages switchable by swiping the LCD strip
- **v2.1.0** — Live audio input monitoring: ALSA capture via ffmpeg, each physical device splits into independent L, R, and Mix logical channels with separate band-pass filter, gain, base frequency and spectrum analyser; low-latency monitoring via WebSocket binary PCM streaming to browser (Web Audio API scheduling, ~100ms latency, replaces HTTP stream which had a 15-second buffering delay); live waveform visualisation in channel and group canvases when a live input is selected as the waveform source; Stream Deck: live audio channels appear as selectable waveforms in the coyote waveform picker, pinned to the top of the list and auto-synced when channels are added or removed; Stream Deck: animated level waveform rendered on the button LCD at 2fps so you can see audio is active at a glance; Tremblr RF device: CC1101 315MHz transmitter, RCSwitch protocol, two-queue Python daemon, start/pause/resume, Stream Deck page
- **v2.0.9** — ILI9341 touchscreen UI for Pi: network status screen (WiFi SSID, IP address, Cloudflare tunnel status), WiFi setup flow (scan → SSID list → password entry → confirm → connect), touch calibration tool, 180° display rotation support, systemd service for boot-time autostart; XPT2046 touch controller with 12-sample noise rejection and debounce
- **v2.0.8** — NimbleBridge ESP32 WiFi adapter: local sine-wave oscillation on ESP32 (eliminates WiFi jitter), 12-byte TCP control packet protocol, auto-force scaling (force = 100 + 0.08 × speed_hz × depth), standalone web UI served from ESP32 (no Pi needed), network scan to discover bridge, WPA2 requirement fix for MicroPython v1.28.0, WiFi power-saving disabled for consistent latency; Pi UI: Add Device WiFi Bridge flow with scan/manual IP entry
- **v2.0.7** — NimbleStroker full control: stroke oscillation (speed/depth/nurture/nature), air in/out, Stream Deck+ page with knobs controlling all four parameters, arc dial LCD strip, momentary air buttons, Run/Stop toggle with flash-on-pause, E-Stop wired to system stop; macro palette reorganised into device sections (Nimble, Coyote, E-Stim); new macro blocks: Nimble Start/Stop/Ramp, E-Stim Ramp (with A/B/Both channel selector), E-Stim SET now includes mode/waveform selection
- **v2.0.6** — Nimble stroker initial integration: USB serial connection, oscillation engine with delta clamping, force control, web UI card with speed/depth/nurture/nature sliders, air in/out hold buttons
- **v2.0.5** — Community login system: username + password registration, Log In tab for returning users on any browser/device, legacy accounts can log in by username and set a password on first login, change password in profile; Fleet dashboard (admin): Pis self-register with community server on first boot, heartbeat every 60s with version/uptime/BLE devices/tunnel status, Fleet tab shows all Pis as online/offline cards with clickable tunnel links
- **v2.0.4** — Shelly Gen 3/4 relay/dimmer support: BLE provisioning flow (auto-scans and connects after provision), network scan to add devices already on WiFi, real-time WebSocket status and component state, I/O tab in web UI with per-device component cards; StreamDeck+ I/O page with one button per switch/light component, amber theme, toggle on/off with colour feedback; I/O SET macro block; Community tab: closed user community for Pi owners with forum (posts/replies, mod/admin controls), waveform sharing (upload MP3 + frames, browse with waveform preview, download directly to Pi), user profiles with avatars; large file uploads streamed Pi→server with real-time progress bar
- **v2.0.3** — per-channel independent playback controls (⏮/⏸/▶ on A and B operate independently); audio sync playback (🔇/🔊 toggle plays source MP3 through browser in sync with BLE output, per channel and per group); waveform sync (Sync button links any combination of channels/groups — waveform changes and play/pause/back propagate in real time); audio edit workflow (Edit button on processed audio reloads original MP3 into staging with previous filter settings restored, no re-upload needed)
- **v2.0.2** — IP camera: ONVIF WS-Discovery scan, stream/profile selection, PTZ controls (D-pad, hold to move), audio via ffmpeg OPUS transcoding, PTZ in popout window; audio waveform playback (▶/⏸), synthesised preview (⚡), animated playhead, base frequency slider per audio file; scrolling waveform visualisation for channels and groups (tick-synced to BLE output, fixed builtin waveform seam), ⏮/⏸/▶ playback controls per channel and group, group enable/disable toggle (releases channels for individual control without deleting the group)
- **v2.0.1** — Philips Hue integration: scenes and rooms on Stream Deck LCD with brightness knobs, active scene tracking (per-group), Set Hue and Hue Ramp macro blocks with live ramp display on Stream Deck, macro monitor view support for Hue blocks
- **v2.0.0** — PawPrints BLE sensor support, new macro blocks (Wait: Paw, Paw: If/Else), streamdeck.js included
- **v1.0.0** — Initial release

## Development

The app runs as a pm2 process. To update a running installation:

```bash
cd /home/alans/edgecontroller
git pull
pm2 restart edgecontroller
```

Key files:
- `server.js` — main server, BLE device management, macro execution engine
- `streamdeck.js` — StreamDeck+ integration
- `public/index.html` — web UI
- `config.json` — device config (not in repo, generated on install)
- `macros.json` — saved macros (not in repo, created by user)
