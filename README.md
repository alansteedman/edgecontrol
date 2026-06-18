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
| Nimble | Motor | USB Serial |
| EOM | Arousal sensor | Network |
| IP Camera | Video | Network |
| Philips Hue | Smart lighting | Network (local bridge) |
| Shelly Gen 3/4 | Relay / dimmer | Network (WiFi) + BLE provisioning |

## Macro Blocks

The visual macro editor supports the following block types:

**Control** — Start, End, Stop All, Run Macro

**Timing** — Delay, Ramp (smooth intensity transition over time), Set Hue (activate a scene or room at a set brightness), Hue Ramp (smoothly ramp scene or room brightness from x% to y% over time)

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

## Versions

- **v2.0.4** — Shelly Gen 3/4 relay/dimmer support: BLE provisioning flow (auto-scans and connects after provision), network scan to add devices already on WiFi, real-time WebSocket status and component state, I/O tab in web UI with per-device component cards; StreamDeck+ I/O page with one button per switch/light component, amber theme, toggle on/off with colour feedback
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
