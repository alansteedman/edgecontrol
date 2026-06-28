import machine
import network
import time
import json

# Deselect display immediately — CS/RST float on cold boot can draw
# current through SPI and destabilise the 3.3V rail during WiFi init.
machine.Pin(15, machine.Pin.OUT).value(1)  # CS HIGH = deselected
machine.Pin(4,  machine.Pin.OUT).value(1)  # RST HIGH = not in reset
machine.Pin(2,  machine.Pin.OUT).value(0)  # DC LOW = idle

WIFI_FILE = 'wifi.json'
AP_SSID   = 'NimbleBridge-Setup'

def load_wifi():
    try:
        with open(WIFI_FILE) as f:
            return json.load(f)
    except:
        return None

def save_wifi(ssid, password):
    with open(WIFI_FILE, 'w') as f:
        json.dump({'ssid': ssid, 'password': password}, f)

def connect_sta(ssid, password):
    ap  = network.WLAN(network.AP_IF)
    sta = network.WLAN(network.STA_IF)

    # Run AP beaconing while connecting in STA mode (AP+STA coexistence).
    # The ESP32 RF TX chain needs to be actively transmitting during the
    # WPA2 4-way handshake — going straight to STA from a cold boot or idle
    # state consistently fails because the PA isn't calibrated. Beacon frames
    # every 100ms keep the TX chain warm throughout the handshake.
    sta.active(False)
    ap.active(True)
    ap.config(essid=AP_SSID, authmode=network.AUTH_OPEN)
    time.sleep(3)

    sta.active(True)
    time.sleep(1)
    try:
        sta.config(txpower=19.5)
    except:
        pass

    print("[boot] scanning...")
    try:
        nets = sta.scan()
        found = [n for n in nets if n[0].decode('utf-8', 'ignore') == ssid]
        if found:
            print(f"[boot] found '{ssid}' ch={found[0][2]} rssi={found[0][3]}")
        else:
            print(f"[boot] '{ssid}' not found ({len(nets)} nets seen)")
    except Exception as e:
        print(f"[boot] scan error: {e}")

    print("[boot] connecting...")
    try:
        sta.disconnect()
    except:
        pass
    time.sleep(0.5)
    try:
        sta.connect(ssid, password)
    except OSError as e:
        print(f"[boot] connect error: {e}")
        ap.active(False)
        sta.active(False)
        return None

    for i in range(1200):  # 120s timeout
        if sta.isconnected():
            ip = sta.ifconfig()[0]
            ap.active(False)
            try:
                sta.config(pm=network.WLAN.PM_NONE)
            except:
                pass
            return ip
        if i % 50 == 0:
            print(f"[boot] {i//10}s status={sta.status()}")
        time.sleep(0.1)

    ap.active(False)
    sta.active(False)
    print("[boot] timed out")
    return None

def start_ap():
    sta = network.WLAN(network.STA_IF)
    sta.active(False)
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid=AP_SSID, authmode=network.AUTH_OPEN)
    while not ap.active():
        time.sleep(0.1)
    return ap.ifconfig()[0]

def _show_connecting(ssid):
    """Show 'Connecting...' screen — silently ignored if display unavailable."""
    try:
        from display import ST7789, BLACK, WHITE, CYAN, GRAY
        d = ST7789()
        d.fill(BLACK)
        d.text("NimbleBridge", 5, 10, CYAN, BLACK, 2)
        d.hline(34)
        d.text("Connecting to WiFi...", 5, 46, GRAY, BLACK, 1)
        d.text(ssid, 5, 64, WHITE, BLACK, 1)
    except Exception as e:
        print(f"[boot] display: {e}")

cfg = load_wifi()
if cfg:
    print(f"[boot] Connecting to {cfg['ssid']}...")
    _show_connecting(cfg['ssid'])
    ip = connect_sta(cfg['ssid'], cfg['password'])
    if ip:
        print(f"[boot] Connected: {ip}")
        MODE = 'sta'
        IP = ip
    else:
        print("[boot] failed, starting AP")
        IP = start_ap()
        MODE = 'ap'
else:
    print("[boot] No config, starting AP")
    IP = start_ap()
    MODE = 'ap'

print(f"[boot] Mode={MODE} IP={IP}")

import machine
machine.Pin(2, machine.Pin.OUT).value(1)

import sys as _sys
class _BootMod:
    pass
_m = _BootMod()
_m.MODE = MODE; _m.IP = IP
_m.AP_SSID = AP_SSID; _m.WIFI_FILE = WIFI_FILE
_m.save_wifi = save_wifi
_sys.modules['boot'] = _m
del _BootMod, _m, _sys
