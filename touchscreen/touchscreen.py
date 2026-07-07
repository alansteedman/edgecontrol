#!/usr/bin/env python3
"""EdgeController touchscreen UI — network status and WiFi setup.

Display: ILI9341 320x240 landscape (MADCTL=0x28) on hardware SPI0 (CE0)
Touch:   XPT2046 on software SPI (bit-bang GPIO via lgpio)

Screens: STATUS → SCANNING → SSID_LIST → PASSWORD → CONFIRM → CONNECTING → RESULT
"""

import spidev
import lgpio
import time
import subprocess
import urllib.request
import urllib.error
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ── GPIO chip ─────────────────────────────────────────────────────────────────
_gpio = lgpio.gpiochip_open(0)

# ── Pin definitions ───────────────────────────────────────────────────────────
DISP_DC    = 24
DISP_RESET = 25

TOUCH_CS   = 5
TOUCH_CLK  = 6
TOUCH_DIN  = 13
TOUCH_DO   = 19
TOUCH_IRQ  = 26

# ── Landscape canvas (320×240) ────────────────────────────────────────────────
W, H = 320, 240
MADCTL = 0xE8   # MY|MX|MV|BGR — landscape 180°
API = "http://localhost:3000"

# ── Colors ────────────────────────────────────────────────────────────────────
BG       = (10,  15,  22)
WHITE    = (240, 240, 245)
CYAN     = (0,   195, 220)
GREEN    = (70,  200, 90)
RED      = (220, 60,  60)
ORANGE   = (255, 150, 0)
GRAY     = (130, 135, 145)
DKGRAY   = (35,  42,  52)
MDGRAY   = (65,  72,  82)
LTGRAY   = (200, 205, 210)
BTN_BG   = (30,  80,  160)
BTN_GRN  = (35,  120, 60)
BTN_RED  = (160, 30,  30)
FIELD_BG = (20,  28,  38)
KEY_BG   = (45,  52,  65)
KEY_ACT  = (80,  90,  115)

# ── Fonts ─────────────────────────────────────────────────────────────────────
_FONT  = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
_FONTB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
try:
    F_SM  = ImageFont.truetype(_FONT,  12)
    F_MD  = ImageFont.truetype(_FONT,  16)
    F_LG  = ImageFont.truetype(_FONTB, 20)
    F_XL  = ImageFont.truetype(_FONTB, 24)
    F_KEY = ImageFont.truetype(_FONT,  14)
except Exception as e:
    print(f"[font] {e}")
    F_SM = F_MD = F_LG = F_XL = F_KEY = ImageFont.load_default()

# ── GPIO helpers ──────────────────────────────────────────────────────────────
def _out(pin, val=0): lgpio.gpio_claim_output(_gpio, pin, val)
def _inp(pin): lgpio.gpio_claim_input(_gpio, pin, lgpio.SET_PULL_UP)
def _write(pin, val): lgpio.gpio_write(_gpio, pin, val)
def _read(pin): return lgpio.gpio_read(_gpio, pin)

for _p in (DISP_DC, DISP_RESET, TOUCH_CS, TOUCH_CLK, TOUCH_DIN): _out(_p, 1)
_inp(TOUCH_DO)
_inp(TOUCH_IRQ)

# ── ILI9341 ───────────────────────────────────────────────────────────────────
_spi = spidev.SpiDev()
_spi.open(0, 0)
_spi.max_speed_hz = 40_000_000
_spi.mode = 0

def _cmd(cmd, *data):
    _write(DISP_DC, 0); _spi.writebytes([cmd])
    if data: _write(DISP_DC, 1); _spi.writebytes(list(data))

def _init_display():
    _write(DISP_RESET, 0); time.sleep(0.05)
    _write(DISP_RESET, 1); time.sleep(0.15)
    _cmd(0x01); time.sleep(0.15)
    _cmd(0x11); time.sleep(0.12)
    _cmd(0xCF, 0x00, 0xC1, 0x30)
    _cmd(0xED, 0x64, 0x03, 0x12, 0x81)
    _cmd(0xE8, 0x85, 0x00, 0x78)
    _cmd(0xCB, 0x39, 0x2C, 0x00, 0x34, 0x02)
    _cmd(0xF7, 0x20); _cmd(0xEA, 0x00, 0x00)
    _cmd(0xC0, 0x23); _cmd(0xC1, 0x10)
    _cmd(0xC5, 0x3E, 0x28); _cmd(0xC7, 0x86)
    _cmd(0x36, MADCTL); _cmd(0x3A, 0x55)
    _cmd(0xB1, 0x00, 0x18); _cmd(0xB6, 0x08, 0x82, 0x27)
    _cmd(0xF2, 0x00); _cmd(0x26, 0x01)
    _cmd(0xE0, 0x0F,0x31,0x2B,0x0C,0x0E,0x08,0x4E,0xF1,0x37,0x07,0x10,0x03,0x0E,0x09,0x00)
    _cmd(0xE1, 0x00,0x0E,0x14,0x03,0x11,0x07,0x31,0xC1,0x48,0x08,0x0F,0x0C,0x31,0x36,0x0F)
    _cmd(0x29); time.sleep(0.1)

def show(image):
    _cmd(0x2A, 0, 0, 1, 63)
    _cmd(0x2B, 0, 0, 0, 239)
    _write(DISP_DC, 0); _spi.writebytes([0x2C]); _write(DISP_DC, 1)
    arr = np.frombuffer(image.tobytes(), dtype=np.uint8).reshape(H, W, 3)
    r = arr[:,:,0].astype(np.uint16)
    g = arr[:,:,1].astype(np.uint16)
    b = arr[:,:,2].astype(np.uint16)
    rgb = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    data = (((rgb & 0xFF) << 8) | (rgb >> 8)).astype(np.uint16).tobytes()
    mv = memoryview(data)
    for off in range(0, len(data), 4096): _spi.writebytes2(mv[off:off+4096])

# ── XPT2046 touch ─────────────────────────────────────────────────────────────
# Calibration — 0xD0 channel measures VERTICAL (high=physical top, low=physical bottom)
#               0x90 channel measures HORIZONTAL (high=physical left, low=physical right)
TOUCH_X_MIN, TOUCH_X_MAX = 579, 3561   # 0xD0 vertical range
TOUCH_Y_MIN, TOUCH_Y_MAX = 557, 3688   # 0x90 horizontal range
_last_touch_t  = 0.0
_touch_released = True

def _touch_byte(val):
    result = 0
    for bit in range(7, -1, -1):
        _write(TOUCH_DIN, (val >> bit) & 1)
        _write(TOUCH_CLK, 1)
        result = (result << 1) | _read(TOUCH_DO)
        _write(TOUCH_CLK, 0)
    return result

def _touch_raw(cmd):
    _touch_byte(cmd)
    hi = _touch_byte(0)
    lo = _touch_byte(0)
    return ((hi << 5) | (lo >> 3)) & 0xFFF

def touch_read(samples=12):
    """Return (x, y) in screen coords, or None.

    Requires consistent X and Y readings (spread < 400) to reject noise.
    Requires finger lift between taps (_touch_released flag).
    """
    global _last_touch_t, _touch_released
    now = time.monotonic()

    _write(TOUCH_CS, 0)
    xs, ys = [], []
    for _ in range(samples):
        x = _touch_raw(0xD0)
        y = _touch_raw(0x90)
        if 100 < x < 4050: xs.append(x)
        if 100 < y < 4050: ys.append(y)
    _write(TOUCH_CS, 1)

    # Need majority of samples in valid range for both axes
    enough = len(xs) >= samples * 2 // 3 and len(ys) >= samples * 2 // 3
    if enough:
        sxs, sys_ = sorted(xs), sorted(ys)
        consistent = (sxs[-1] - sxs[0]) < 400 and (sys_[-1] - sys_[0]) < 400
    else:
        consistent = False

    if not (enough and consistent):
        _touch_released = True   # finger lifted — next real tap will register
        return None

    if not _touch_released or now - _last_touch_t < 0.5:
        return None

    rx = sorted(xs)[len(xs) // 2]  # 0xD0: measures vertical (high=physical top=visual bottom)
    ry = sorted(ys)[len(ys) // 2]  # 0x90: measures horizontal (high=physical left=visual right)
    # Axes are swapped and inverted; with MADCTL=0xE8 the inversions cancel the 180° flip
    tx = int((ry - TOUCH_Y_MIN) * W / (TOUCH_Y_MAX - TOUCH_Y_MIN))
    ty = int((rx - TOUCH_X_MIN) * H / (TOUCH_X_MAX - TOUCH_X_MIN))
    _last_touch_t = now
    _touch_released = False
    return max(0, min(W-1, tx)), max(0, min(H-1, ty))

# ── Drawing helpers ───────────────────────────────────────────────────────────
def text_centered(draw, text, y, color, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, y), text, fill=color, font=font)

def button(draw, x, y, w, h, label, bg, fg=WHITE, font=None):
    if font is None: font = F_MD
    draw.rounded_rectangle([x, y, x+w, y+h], radius=7, fill=bg)
    if label:
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
        draw.text((x+(w-tw)//2, y+(h-th)//2 - bbox[1]), label, fill=fg, font=font)

def header(draw, title, subtitle=None):
    draw.rectangle([0, 0, W, 36], fill=DKGRAY)
    if subtitle:
        text_centered(draw, title, 2, CYAN, F_LG)
        text_centered(draw, subtitle, 22, GRAY, F_SM)
    else:
        text_centered(draw, title, 8, CYAN, F_LG)

def wifi_bars(draw, x, y, signal):
    bars = max(0, min(4, signal // 25))
    for i in range(4):
        bh = 3 + i * 3
        draw.rectangle([x+i*5, y+(12-bh), x+i*5+3, y+12],
                       fill=CYAN if i < bars else MDGRAY)

# ── Network helpers ───────────────────────────────────────────────────────────
def get_network_info():
    try:
        r = subprocess.run(
            ['nmcli', '-t', '-f', 'GENERAL.CONNECTION,IP4.ADDRESS', 'dev', 'show', 'wlan0'],
            capture_output=True, text=True, timeout=3)
        ssid = ip = None
        for line in r.stdout.splitlines():
            if 'GENERAL.CONNECTION:' in line:
                v = line.split(':', 1)[1].strip()
                if v and v != '--': ssid = v
            elif 'IP4.ADDRESS' in line:
                v = line.split(':', 1)[1].split('/')[0].strip()
                if v: ip = v
        return ssid, ip
    except Exception:
        return None, None

def get_tunnel_info(ip):
    try:
        with open('/home/alans/edgecontroller/config.json') as f:
            cfg = json.load(f)
        tunnel = cfg.get('tunnel', {})
        if not tunnel.get('enabled'): return False, None, None, None
        ext = tunnel.get('hostname', '').rstrip('/')
        ssh = tunnel.get('sshHostname', '')
        internal = f"http://{ip}:3000" if ip else "http://localhost:3000"
        active = subprocess.run(['pgrep', '-x', 'cloudflared'], capture_output=True).returncode == 0
        return active, ext, internal, ssh
    except Exception:
        return False, None, None, None

def api_get(path, timeout=4):
    try:
        with urllib.request.urlopen(f"{API}{path}", timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return {}

def api_post(path, body, timeout=12):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return False, json.loads(e.read())
        except: return False, {'error': str(e)}
    except Exception as e:
        return False, {'error': str(e)}

def fmt_uptime(secs):
    s = int(secs)
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s//60}m"
    return f"{s//3600}h{(s%3600)//60}m"

# ── Screen renderers ──────────────────────────────────────────────────────────
def draw_status(info):
    ssid, ip = info.get('ssid'), info.get('ip')
    st = info.get('status', {})
    ap = info.get('ap', {})
    in_ap = ap.get('apMode', False)
    cf_active, cf_ext, cf_int, _ = info.get('tunnel', (False, None, None, None))

    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d, "EdgeController", f"box: {st.get('boxId','—')}")

    if in_ap:
        dot_color, wifi_label = ORANGE, "Hotspot"
        ssid = ap.get('ssid', '—')
    elif ip:
        dot_color, wifi_label = GREEN, "WiFi"
    else:
        dot_color, wifi_label = RED, "No WiFi"

    d.ellipse([12, 43, 22, 53], fill=dot_color)
    d.text((28, 41), wifi_label, fill=dot_color, font=F_SM)
    d.text((28, 55), (ssid or "—")[:20], fill=WHITE, font=F_MD)
    ip_str = ip or "—"
    ip_bbox = d.textbbox((0,0), ip_str, font=F_SM)
    d.text((W - ip_bbox[2] - 12, 58), ip_str, fill=GRAY, font=F_SM)
    d.line([0, 76, W, 76], fill=MDGRAY)

    cf_dot = GREEN if cf_active else (RED if cf_ext else MDGRAY)
    cf_label = "Tunnel active" if cf_active else ("Tunnel offline" if cf_ext else "No tunnel")
    d.ellipse([12, 83, 22, 93], fill=cf_dot)
    d.text((28, 81), cf_label, fill=cf_dot, font=F_SM)
    if cf_int: d.text((12, 98),  "int", fill=GRAY, font=F_SM); d.text((36, 98),  cf_int, fill=WHITE, font=F_SM)
    if cf_ext: d.text((12, 112), "ext", fill=GRAY, font=F_SM); d.text((36, 112), cf_ext, fill=CYAN,  font=F_SM)
    d.line([0, 130, W, 130], fill=MDGRAY)

    footer_str = (f"v{st.get('version','?')}  ·  up {fmt_uptime(st.get('uptime',0))}"
                  f"  ·  {st.get('deviceCount',0)} device{'s' if st.get('deviceCount',0)!=1 else ''}")
    text_centered(d, footer_str, 134, MDGRAY, F_SM)
    button(d, 12, 152, W-24, 76, "WiFi Setup", BTN_BG, WHITE, F_LG)
    return img

def draw_scanning():
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d, "WiFi Setup")
    text_centered(d, "Scanning for networks...", 105, WHITE, F_LG)
    text_centered(d, "Please wait", 133, GRAY, F_MD)
    return img

def draw_ssid_list(networks, scroll=0):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d, "Select Network", f"{len(networks)} found")
    ROW_H, VISIBLE, y0 = 42, 3, 40
    if not networks:
        text_centered(d, "No networks found", 110, GRAY, F_MD)
        text_centered(d, "Move closer to the router", 132, GRAY, F_SM)
    else:
        for i in range(VISIBLE):
            idx = scroll + i
            if idx >= len(networks): break
            net = networks[idx]
            y = y0 + i * ROW_H
            bg = DKGRAY if net.get('inUse') else (22, 30, 40)
            d.rounded_rectangle([6, y, W-6, y+ROW_H-3], radius=5, fill=bg)
            wifi_bars(d, W-42, y+13, net.get('signal', 0))
            ssid = net.get('ssid', '?')
            if len(ssid) > 28: ssid = ssid[:27] + '…'
            d.text((12, y+6), ssid, fill=CYAN if net.get('inUse') else WHITE, font=F_MD)
            d.text((12, y+24), f"{net.get('security','Open')} · {net.get('signal',0)}%",
                   fill=GRAY, font=F_SM)
    ROWS_BOT = y0 + VISIBLE * ROW_H
    if scroll > 0: text_centered(d, "▲", y0-14, GRAY, F_SM)
    if scroll + VISIBLE < len(networks): text_centered(d, "▼", ROWS_BOT+4, GRAY, F_SM)
    button(d, 6, H-38, W-12, 34, "← Back", MDGRAY, WHITE, F_MD)
    return img

# ── Keyboard ──────────────────────────────────────────────────────────────────
_KBD_LOWER = [list("qwertyuiop"), list("asdfghjkl") + ["⌫"], ["⇧"] + list("zxcvbnm.")]
_KBD_UPPER = [list("QWERTYUIOP"), list("ASDFGHJKL") + ["⌫"], ["⇧"] + list("ZXCVBNM.")]
_KBD_NUM   = [list("1234567890"), list("!@#$%^&*()"), list("-_=+[]{};/") + ["⌫"]]
KBD_Y0, KBD_KH = 88, 42

def _build_keys(rows):
    keys = []
    for ri, row in enumerate(rows):
        y = KBD_Y0 + ri * KBD_KH
        n = len(row); kw = W // n
        for ci, ch in enumerate(row):
            x = ci * kw
            w = kw if ci < n-1 else W - x
            keys.append((x, y, w, KBD_KH, ch))
    return keys

def draw_password(ssid, password, caps=False, num_mode=False):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    lbl = ssid[:32] + '…' if len(ssid) > 33 else ssid
    header(d, "Enter Password", lbl)
    d.rounded_rectangle([6, 40, W-6, 80], radius=6, fill=FIELD_BG)
    if password:
        d.text((14, 52), password[-34:], fill=WHITE, font=F_MD)
    else:
        d.text((14, 52), "Password", fill=MDGRAY, font=F_MD)
    rows = _KBD_NUM if num_mode else (_KBD_UPPER if caps else _KBD_LOWER)
    keys = _build_keys(rows)
    for x, y, kw, kh, ch in keys:
        bg = KEY_ACT if (ch == "⇧" and caps and not num_mode) else KEY_BG
        d.rounded_rectangle([x+1, y+1, x+kw-1, y+kh-1], radius=4, fill=bg)
        bbox = d.textbbox((0, 0), ch, font=F_KEY)
        tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
        d.text((x+(kw-tw)//2, y+(kh-th)//2 - bbox[1]), ch, fill=WHITE, font=F_KEY)
    bottom_y = KBD_Y0 + len(rows) * KBD_KH
    button(d, 0,     bottom_y, 56,      H-bottom_y, "123" if not num_mode else "ABC", MDGRAY, WHITE, F_SM)
    button(d, 58,    bottom_y, 70,      H-bottom_y, "← Back", MDGRAY,   WHITE, F_SM)
    button(d, 130,   bottom_y, W-214,   H-bottom_y, "space",  MDGRAY,   GRAY,  F_SM)
    button(d, W-84,  bottom_y, 84,      H-bottom_y, "Connect", BTN_GRN, WHITE, F_SM)
    return img, keys

def hit_key(keys, tx, ty):
    for x, y, kw, kh, ch in keys:
        if x <= tx < x+kw and y <= ty < y+kh: return ch
    return None

def draw_confirm(ssid, password):
    """Confirmation screen — user must explicitly tap Connect to proceed."""
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d, "Confirm Connection")
    text_centered(d, "Connect to:", 50, GRAY, F_MD)
    text_centered(d, ssid[:28], 72, CYAN, F_LG)
    if password:
        text_centered(d, f"Password: {'•' * min(len(password), 20)}", 102, GRAY, F_SM)
    else:
        text_centered(d, "No password (open network)", 102, GRAY, F_SM)
    text_centered(d, "Are you sure?", 126, WHITE, F_MD)
    button(d, 8,       158, W//2-12, 60, "Cancel", BTN_RED,  WHITE, F_LG)
    button(d, W//2+4,  158, W//2-12, 60, "Connect", BTN_GRN, WHITE, F_LG)
    return img

def draw_connecting(ssid):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d, "Connecting")
    text_centered(d, "Connecting to:", 90, GRAY, F_MD)
    text_centered(d, ssid[:30], 112, CYAN, F_LG)
    text_centered(d, "Please wait...", 148, GRAY, F_SM)
    return img

def draw_result(ok, ssid, msg, ip=None):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    if ok:
        header(d, "Connected!")
        d.ellipse([W//2-28, 50, W//2+28, 106], fill=(0, 55, 0))
        text_centered(d, "✓", 60, GREEN, F_XL)
        text_centered(d, ssid[:28], 118, CYAN, F_MD)
        if ip: text_centered(d, ip, 140, WHITE, F_MD)
        text_centered(d, "Network saved.", 162, GRAY, F_SM)
    else:
        header(d, "Failed")
        d.ellipse([W//2-28, 50, W//2+28, 106], fill=(55, 0, 0))
        text_centered(d, "✗", 60, RED, F_XL)
        err = msg.get('error', str(msg)) if isinstance(msg, dict) else str(msg)
        words = err.split()
        lines, cur = [], []
        for w in words:
            cur.append(w)
            if len(' '.join(cur)) > 36: lines.append(' '.join(cur[:-1])); cur = [w]
        if cur: lines.append(' '.join(cur))
        for li, line in enumerate(lines[:3]):
            text_centered(d, line, 116 + li*18, LTGRAY, F_SM)
    button(d, W//2-70, H-50, 140, 40, "Done", BTN_BG, WHITE, F_MD)
    return img

# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    print("[ui] init display")
    _init_display()

    splash = Image.new('RGB', (W, H), BG)
    sd = ImageDraw.Draw(splash)
    text_centered(sd, "EdgeController", 95, CYAN, F_XL)
    text_centered(sd, "Starting...", 128, GRAY, F_MD)
    show(splash)

    state = 'STATUS'
    networks, scroll = [], 0
    selected_ssid = None
    password, caps, num_mode = '', False, False
    pw_keys = []
    result_ok, result_msg, result_ip = False, {}, None

    def fetch_status():
        ssid, ip = get_network_info()
        return {'ssid': ssid, 'ip': ip,
                'status': api_get('/api/status'),
                'ap': api_get('/api/wifi/ap-status'),
                'tunnel': get_tunnel_info(ip)}

    info = fetch_status()
    last_refresh = time.monotonic()
    prev_state = None
    needs_redraw = True

    print("[ui] ready")

    while True:
        now = time.monotonic()

        if state == 'STATUS' and now - last_refresh > 15:
            info = fetch_status(); last_refresh = now; needs_redraw = True

        if state != prev_state:
            needs_redraw = True; prev_state = state

        if needs_redraw:
            if state == 'STATUS':
                img = draw_status(info)
            elif state == 'SSID_LIST':
                img = draw_ssid_list(networks, scroll)
            elif state == 'PASSWORD':
                img, pw_keys = draw_password(selected_ssid, password, caps, num_mode)
            elif state == 'CONFIRM':
                img = draw_confirm(selected_ssid, password)
            elif state == 'RESULT':
                img = draw_result(result_ok, selected_ssid, result_msg, result_ip)
            if state not in ('SCANNING', 'CONNECTING'):
                show(img)
            needs_redraw = False

        if state == 'SCANNING':
            show(draw_scanning())
            ok, result = api_post('/api/wifi/scan', {})
            networks = result if (ok and isinstance(result, list)) else []
            scroll = 0; state = 'SSID_LIST'; continue

        if state == 'CONNECTING':
            show(draw_connecting(selected_ssid))
            body = {'ssid': selected_ssid}
            if password: body['password'] = password
            result_ok, result_msg = api_post('/api/wifi/connect', body, timeout=30)
            if result_ok:
                time.sleep(2); _, result_ip = get_network_info()
                info = fetch_status(); last_refresh = time.monotonic()
            else:
                result_ip = None
            state = 'RESULT'; continue

        pt = touch_read()
        if pt is None:
            time.sleep(0.05); continue
        tx, ty = pt
        print(f"[touch] state={state} tx={tx} ty={ty}")

        if state == 'STATUS':
            if ty >= 152 and 12 <= tx <= W-12:
                state = 'SCANNING'

        elif state == 'SSID_LIST':
            ROW_H, VISIBLE, y0 = 42, 3, 40
            if ty >= H-38:
                state = 'STATUS'; last_refresh = 0
            elif y0 <= ty < y0 + VISIBLE * ROW_H:
                idx = scroll + (ty - y0) // ROW_H
                if 0 <= idx < len(networks):
                    selected_ssid = networks[idx]['ssid']
                    password, caps, num_mode = '', False, False
                    state = 'PASSWORD'
            elif ty < y0 and scroll > 0:
                scroll -= 1; needs_redraw = True
            elif ty > y0 + VISIBLE * ROW_H and scroll + VISIBLE < len(networks):
                scroll = min(scroll + 1, len(networks) - VISIBLE); needs_redraw = True

        elif state == 'PASSWORD':
            bottom_y = KBD_Y0 + len(_KBD_LOWER) * KBD_KH
            if ty >= bottom_y:
                if tx < 56:
                    num_mode = not num_mode; caps = False; needs_redraw = True
                elif tx < 128:
                    state = 'SSID_LIST'; needs_redraw = True   # Back
                elif tx >= W - 84:
                    state = 'CONFIRM'
                else:
                    password += ' '; needs_redraw = True
            else:
                ch = hit_key(pw_keys, tx, ty)
                if ch == '⌫':
                    password = password[:-1]; needs_redraw = True
                elif ch == '⇧':
                    caps = not caps; needs_redraw = True
                elif ch:
                    password += ch
                    if caps and not num_mode: caps = False
                    needs_redraw = True

        elif state == 'CONFIRM':
            # Cancel = left half, Connect = right half
            if ty >= 158 and ty <= 218:
                if tx < W // 2:
                    state = 'PASSWORD'   # back to password entry
                else:
                    state = 'CONNECTING'

        elif state == 'RESULT':
            if ty >= H-50 and W//2-70 <= tx <= W//2+70:
                state = 'STATUS'; last_refresh = 0

# ── Calibration ───────────────────────────────────────────────────────────────
def calibrate():
    print("Touch calibration — tap each crosshair when prompted")
    _init_display()
    _cmd(0x36, 0x28)   # standard orientation so crosshairs land in expected corners

    def cross(x, y, label):
        img = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(img)
        d.line([x-15, y, x+15, y], fill=WHITE, width=2)
        d.line([x, y-15, x, y+15], fill=WHITE, width=2)
        d.ellipse([x-3, y-3, x+3, y+3], fill=CYAN)
        text_centered(d, f"Tap {label}", H//2, WHITE, F_MD)
        show(img)

    corners = [(20,20,"top-left"), (W-20,20,"top-right"),
               (20,H-20,"bottom-left"), (W-20,H-20,"bottom-right")]
    readings = []
    for cx, cy, name in corners:
        cross(cx, cy, name)
        print(f"  Tap {name}...", end='', flush=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            _write(TOUCH_CS, 0)
            xs, ys = [], []
            for _ in range(15):
                x = _touch_raw(0xD0); y = _touch_raw(0x90)
                if 100 < x < 4050: xs.append(x)
                if 100 < y < 4050: ys.append(y)
            _write(TOUCH_CS, 1)
            if len(xs) >= 8 and len(ys) >= 8:
                rx = sorted(xs)[len(xs)//2]; ry = sorted(ys)[len(ys)//2]
                readings.append((cx, cy, rx, ry))
                print(f" raw x={rx} y={ry}")
                time.sleep(0.8)
                break
            time.sleep(0.05)
        else:
            print(" (timeout — skipped)")

    if readings:
        x_mins = [r[2] for r in readings if r[0] < W//2]
        x_maxs = [r[2] for r in readings if r[0] > W//2]
        y_mins = [r[3] for r in readings if r[1] < H//2]
        y_maxs = [r[3] for r in readings if r[1] > H//2]
        print("\nAdd to touchscreen.py:")
        if x_mins and x_maxs:
            print(f"  TOUCH_X_MIN, TOUCH_X_MAX = {min(x_mins)}, {max(x_maxs)}")
        if y_mins and y_maxs:
            print(f"  TOUCH_Y_MIN, TOUCH_Y_MAX = {min(y_mins)}, {max(y_maxs)}")
    _cmd(0x36, MADCTL)   # restore 180° flip

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'calibrate':
        calibrate()
    else:
        main()
