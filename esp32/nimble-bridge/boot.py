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

def connect_sta(ssid, password, timeout=15):
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    sta.connect(ssid, password)
    for _ in range(timeout * 10):
        if sta.isconnected():
            return sta.ifconfig()[0]
        time.sleep(0.1)
    sta.active(False)
    return None

def start_ap():
    # Disable station mode
    sta = network.WLAN(network.STA_IF)
    sta.active(False)
    # Start AP
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid=AP_SSID, password=AP_PASS, authmode=network.AUTH_WPA_WPA2_PSK)
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
