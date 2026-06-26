import network
import time
import json

WIFI_FILE = 'wifi.json'
AP_SSID   = 'NimbleBridge-Setup'
AP_PASS   = 'nimble123'

def load_wifi():
    try:
        with open(WIFI_FILE) as f:
            return json.load(f)
    except:
        return None

def save_wifi(ssid, password):
    with open(WIFI_FILE, 'w') as f:
        json.dump({'ssid': ssid, 'password': password}, f)

def connect_sta(ssid, password, timeout=30):
    # Ensure AP is off first — having both active causes internal WiFi errors
    ap = network.WLAN(network.AP_IF)
    if ap.active():
        ap.active(False)
        time.sleep(0.5)
    sta = network.WLAN(network.STA_IF)
    sta.active(False)
    time.sleep(0.3)
    sta.active(True)
    time.sleep(0.3)
    if sta.isconnected():
        return sta.ifconfig()[0]
    try:
        sta.connect(ssid, password)
    except OSError as e:
        print(f"[boot] connect error: {e}")
        sta.active(False)
        return None
    for i in range(timeout * 10):
        if sta.isconnected():
            ip = sta.ifconfig()[0]
            try:
                sta.config(pm=network.WLAN.PM_NONE)
                print("[boot] Power saving disabled")
            except Exception as e:
                print(f"[boot] pm set failed: {e}")
            return ip
        st = sta.status()
        if st not in (1000, 1001):
            print(f"[boot] WiFi failed — status {st}")
            sta.active(False)
            return None
        if i % 20 == 0:
            print(f"[boot] Waiting... status={st}")
        time.sleep(0.1)
    print("[boot] WiFi timed out")
    sta.active(False)
    return None

def start_ap():
    # Disable station mode
    sta = network.WLAN(network.STA_IF)
    sta.active(False)
    # Start AP
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid=AP_SSID, authmode=network.AUTH_OPEN)
    while not ap.active():
        time.sleep(0.1)
    return ap.ifconfig()[0]

# Try to connect to saved WiFi; fall back to AP mode
cfg = load_wifi()
if cfg:
    print(f"[boot] Connecting to {cfg['ssid']}...")
    ip = connect_sta(cfg['ssid'], cfg['password'])
    if ip:
        print(f"[boot] Connected — IP: {ip}")
        MODE = 'sta'
        IP = ip
    else:
        print("[boot] WiFi failed — starting AP mode")
        IP = start_ap()
        MODE = 'ap'
else:
    print("[boot] No WiFi config — starting AP mode")
    IP = start_ap()
    MODE = 'ap'

print(f"[boot] Mode: {MODE}  IP: {IP}")

# Hand GPIO2 (display DC pin) back to application — must happen AFTER
# WiFi/AP is fully started, before display initialisation in main.py
import machine
machine.Pin(2, machine.Pin.OUT).value(1)

# Register this module in sys.modules so that 'import boot' in main.py
# returns the already-executed module instead of re-running this file.
import sys as _sys
class _BootMod:
    pass
_m = _BootMod()
_m.MODE = MODE; _m.IP = IP
_m.AP_SSID = AP_SSID; _m.WIFI_FILE = WIFI_FILE
_m.save_wifi = save_wifi
_sys.modules['boot'] = _m
del _BootMod, _m, _sys
