import machine
import uasyncio as asyncio
import math
import gc

import boot
from display import ST7789, BLACK, WHITE, CYAN, GREEN, ORANGE, GRAY, DKGRAY, RED

# ── Hardware ──────────────────────────────────────────────────────────────
machine.Pin(32, machine.Pin.OUT).value(1)   # backlight on

uart = machine.UART(2, baudrate=115200, tx=machine.Pin(17), rx=machine.Pin(16),
                    bits=8, parity=None, stop=1, rxbuf=256)

disp = ST7789()

TCP_PORT = 8765

# ── Screens ───────────────────────────────────────────────────────────────
def screen_ap():
    disp.fill(BLACK)
    disp.text("NimbleBridge", 5, 15, CYAN, BLACK, 2)
    disp.text("Setup Mode",   5, 35, WHITE, BLACK, 2)
    disp.hline(60)
    disp.text("1. Connect to WiFi:", 5, 72, GRAY, BLACK, 1)
    disp.text("NimbleBridge-Setup", 5, 84, WHITE, BLACK, 1)
    disp.text("   nimble123",       5, 96, GRAY, BLACK, 1)
    disp.hline(112)
    disp.text("2. Open browser:", 5, 120, GRAY, BLACK, 1)
    disp.text("192.168.4.1",     5, 132, CYAN, BLACK, 1)
    disp.hline(150)
    disp.text("Enter your home", 5, 158, GRAY, BLACK, 1)
    disp.text("WiFi details", 5, 170, GRAY, BLACK, 1)
    disp.text("and hit Save.", 5, 182, GRAY, BLACK, 1)

def screen_waiting(ip):
    disp.fill(BLACK)
    disp.text("NimbleBridge", 5, 15, CYAN, BLACK, 2)
    disp.hline(40)
    disp.text("IP address:", 5, 52, GRAY, BLACK, 1)
    disp.text(ip,            5, 64, WHITE, BLACK, 1)
    disp.hline(80)
    disp.text("Waiting for Pi", 5, 92, GRAY, BLACK, 1)
    disp.text("to connect...",  5, 104, GRAY, BLACK, 1)

def screen_connected(ip, peer):
    disp.fill(BLACK)
    disp.text("NimbleBridge", 5, 15, CYAN, BLACK, 2)
    disp.hline(40)
    disp.text("IP address:", 5, 52, GRAY, BLACK, 1)
    disp.text(ip,            5, 64, WHITE, BLACK, 1)
    disp.hline(80)
    disp.text("Pi connected:", 5, 92, GREEN, BLACK, 1)
    disp.text(peer,           5, 104, WHITE, BLACK, 1)
    disp.hline(120)
    disp.text("Bridge active", 5, 132, GREEN, BLACK, 2)

# ── WiFi setup HTTP server (AP mode) ─────────────────────────────────────
FORM_HTML = b"""HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NimbleBridge Setup</title>
<style>body{font-family:sans-serif;max-width:360px;margin:40px auto;padding:0 20px;background:#0f0f0f;color:#e0e0e0}
h2{color:#4fc3f7;margin-bottom:4px}p{color:#555;font-size:12px;margin:0 0 20px}
label{display:block;margin:12px 0 4px;font-size:13px;color:#888}
input{width:100%;box-sizing:border-box;padding:10px;background:#1a1a1a;border:1px solid #333;
color:#e0e0e0;border-radius:6px;font-size:15px}
button{margin-top:20px;width:100%;padding:13px;background:#1a3a6a;color:#4fc3f7;
border:1px solid #2a5aaa;border-radius:6px;font-size:15px;cursor:pointer}</style></head>
<body><h2>NimbleBridge</h2><p>WiFi Setup</p>
<form method="POST" action="/save">
<label>WiFi Network (SSID)</label><input name="ssid" type="text" autocomplete="off" autocorrect="off" spellcheck="false">
<label>Password</label><input name="pass" type="password">
<button type="submit">Save &amp; Connect</button>
</form></body></html>"""

OK_HTML = b"""HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Saved</title>
<style>body{font-family:sans-serif;max-width:360px;margin:40px auto;padding:0 20px;
background:#0f0f0f;color:#e0e0e0}h2{color:#4ade80}</style></head>
<body><h2>&#10003; Saved</h2>
<p style="color:#888">NimbleBridge is connecting to your network and will restart shortly.
The setup hotspot will disappear — reconnect to your home WiFi.</p></body></html>"""

def _urldecode(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == '%' and i+2 < len(s):
            out.append(chr(int(s[i+1:i+3], 16))); i += 3
        else:
            out.append(s[i]); i += 1
    return ''.join(out)

async def handle_setup(reader, writer):
    try:
        req = await asyncio.wait_for(reader.read(1024), timeout=3)
        req_str = req.decode('utf-8', 'ignore')
        if 'POST /save' in req_str:
            body = req_str.split('\r\n\r\n', 1)[-1] if '\r\n\r\n' in req_str else ''
            params = {}
            for part in body.strip().split('&'):
                if '=' in part:
                    k, v = part.split('=', 1)
                    params[k] = _urldecode(v.replace('+', ' '))
            ssid = params.get('ssid', '').strip()
            pw   = params.get('pass', '').strip()
            writer.write(OK_HTML)
            await writer.drain()
            await writer.aclose()
            if ssid:
                print(f"[setup] Saving WiFi: ssid={repr(ssid)} pw={repr(pw)}")
                # Show saving screen
                disp.fill(BLACK)
                disp.text("NimbleBridge", 5, 15, CYAN, BLACK, 2)
                disp.hline(40)
                disp.text("Saving...", 5, 60, WHITE, BLACK, 2)
                disp.text("Connecting to:", 5, 90, GRAY, BLACK, 1)
                disp.text(ssid, 5, 102, WHITE, BLACK, 1)
                boot.save_wifi(ssid, pw)
                await asyncio.sleep(2)
                machine.reset()
        else:
            writer.write(FORM_HTML)
            await writer.drain()
    except Exception as e:
        print(f"[setup] {e}")
    finally:
        try: await writer.aclose()
        except: pass

# ── TCP bridge (STA mode) ─────────────────────────────────────────────────
# Oscillation parameters sent by the Pi as a 12-byte control packet (magic 0xFE).
# The ESP32 runs the sine wave locally so WiFi jitter never affects UART timing.
_client_writer = None
_ctl = {
    'activated': False, 'running': False, 'airOut': False, 'airIn': False,
    'force': 0, 'speed': 0.5, 'depth': 500.0, 'offset': 0.0,
    'texture': 0.0, 'nature': 20.0,
}

def _parse_ctrl(pkt):
    if len(pkt) < 12 or pkt[0] != 0xFE:
        return False
    flags = pkt[1]
    _ctl['activated'] = bool(flags & 1)
    _ctl['running']   = bool(flags & 2)
    _ctl['airOut']    = bool(flags & 4)
    _ctl['airIn']     = bool(flags & 8)
    _ctl['force']     = pkt[2] | (pkt[3] << 8)
    _ctl['speed']     = (pkt[4] | (pkt[5] << 8)) / 1000.0   # stored as mHz
    _ctl['depth']     = pkt[6] | (pkt[7] << 8)
    raw = pkt[8] | (pkt[9] << 8)
    _ctl['offset']    = raw - 0x10000 if raw >= 0x8000 else raw
    _ctl['texture']   = pkt[10]
    _ctl['nature']    = pkt[11]
    return True

async def uart_sender():
    """Compute oscillation locally; write UART at a steady 20 ms."""
    dt = 0.02
    phase = 0.0
    vib_phase = 0.0
    prev_pos = 0
    while True:
        c = _ctl
        if c['activated'] and c['running']:
            phase     += 2.0 * math.pi * c['speed']  * dt
            vib_phase += 2.0 * math.pi * c['nature'] * dt
            stroke_amp = max(0.0, c['depth'] - c['texture'])
            raw = c['offset'] + stroke_amp * math.sin(phase) + c['texture'] * math.sin(vib_phase)
            delta = max(-300.0, min(300.0, raw - prev_pos))
            pos = int(max(-1000.0, min(1000.0, prev_pos + delta)))
        else:
            pos = 0
        prev_pos = pos

        frc    = max(100, min(900, int(100 + 0.08 * c['speed'] * c['depth']))) if c['activated'] else 0
        pa     = abs(pos)
        ps     = 1 if pos < 0 else 0
        b0 = 0x80 | (1 if c['activated'] else 0) | (2 if c['airOut'] else 0) | (4 if c['airIn'] else 0)
        b1 = pa & 0xFF
        b2 = (ps << 2) | ((pa >> 8) & 0x03)
        b3 = frc & 0xFF
        b4 = (frc >> 8) & 0x03
        ck = b0 + b1 + b2 + b3 + b4
        uart.write(bytes([b0, b1, b2, b3, b4, ck & 0xFF, (ck >> 8) & 0xFF]))
        await asyncio.sleep_ms(20)

async def uart_to_tcp():
    global _client_writer
    buf = bytearray()
    while True:
        if uart.any():
            data = uart.read(64)
            if data:
                buf += data
                while len(buf) >= 7:
                    pkt = buf[:7]
                    _parse_feedback(pkt)
                    if _client_writer:
                        try:
                            _client_writer.write(bytes(pkt))
                            await _client_writer.drain()
                        except:
                            _client_writer = None
                    buf = buf[7:]
        await asyncio.sleep_ms(5)

async def handle_bridge(reader, writer):
    global _client_writer
    peer = writer.get_extra_info('peername')[0]
    print(f"[bridge] Pi connected from {peer}")
    _client_writer = writer
    screen_connected(boot.IP, peer)
    buf = bytearray()
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(reader.read(64), timeout=1)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= 12:
                    if buf[0] == 0xFE:
                        _parse_ctrl(buf[:12])
                        buf = buf[12:]
                    else:
                        buf = buf[1:]  # discard unrecognised byte
            except asyncio.TimeoutError:
                continue
    except Exception as e:
        print(f"[bridge] {e}")
    finally:
        _client_writer = None
        _ctl['activated'] = False
        _ctl['running'] = False
        print("[bridge] Pi disconnected")
        screen_waiting(boot.IP)
        try: await writer.aclose()
        except: pass
    gc.collect()

# ── Standalone web UI (STA mode, port 80) ────────────────────────────────
import json as _json

_feedback = {'pos': 0, 'force': 0, 'present': False}

def _parse_feedback(pkt):
    if len(pkt) < 7: return
    ck = pkt[0]+pkt[1]+pkt[2]+pkt[3]+pkt[4]
    if (ck&0xFF)!=pkt[5] or ((ck>>8)&0xFF)!=pkt[6]: return
    pa = ((pkt[2]&0x03)<<8)|pkt[1]
    pos = -pa if (pkt[2]>>2)&1 else pa
    fw = ((pkt[4]&0x07)<<8)|pkt[3]
    frc = -(fw&0x3FF) if fw&0x400 else fw
    _feedback['pos'] = pos; _feedback['force'] = frc; _feedback['present'] = True

_WEB_HTML = b"""<!DOCTYPE html>
<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>NimbleBridge</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#111;color:#e0e0e0;padding:12px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px;max-width:480px;margin:0 auto}
.hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:14px}
.hdr .nm{font-size:15px;font-weight:600}.hdr .ip{font-size:11px;color:#555}
.run-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
#btn-run{padding:7px 16px;border-radius:20px;border:1px solid #333;background:#1a1a1a;color:#666;font-size:13px;cursor:pointer}
#btn-run.on{background:#14532d;color:#4ade80;border-color:#166534}
.sts{font-size:12px;color:#555}
.sl{margin:10px 0}
.sl .lbl{font-size:10px;letter-spacing:.05em;color:#555;text-transform:uppercase;display:flex;justify-content:space-between;margin-bottom:5px}
.sl input{width:100%;cursor:pointer}
.air{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.air button{padding:11px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;color:#888;font-size:13px;cursor:pointer;-webkit-user-select:none;user-select:none}
.air button.on{border-color:#444;color:#e0e0e0;background:#222}
.fb{display:flex;gap:14px;margin-top:12px;padding-top:10px;border-top:1px solid #222;font-size:11px;color:#555}
.fb b{color:#888}
</style></head><body>
<div class='card'>
<div class='hdr'><span class='nm'>NimbleBridge</span><span class='ip' id='ipad'></span></div>
<div class='run-row'><button id='btn-run' onclick='toggleRun()'>&#9654; Run</button><span class='sts' id='sts'>stopped</span></div>
<div class='sl'><div class='lbl'><span>STROKE SPEED</span><span id='vspm' style='color:#4fc3f7'>30</span></div>
<input type='range' min='6' max='300' step='1' id='spm' style='accent-color:#4fc3f7' oninput='dv("speed",this.value/60,"vspm",this.value)'></div>
<div class='sl'><div class='lbl'><span>STROKE DEPTH</span><span id='vdep' style='color:#a78bfa'>500</span></div>
<input type='range' min='0' max='1000' step='10' id='dep' style='accent-color:#a78bfa' oninput='dv("depth",+this.value,"vdep",this.value)'></div>
<div class='sl'><div class='lbl'><span>NURTURE (VIBRATION INTENSITY)</span><span id='vtex' style='color:#f472b6'>0</span></div>
<input type='range' min='0' max='200' step='1' id='tex' style='accent-color:#f472b6' oninput='dv("texture",+this.value,"vtex",this.value)'></div>
<div class='sl'><div class='lbl'><span>NATURE (VIBRATION SPEED)</span><span id='vnat' style='color:#fb923c'>20</span></div>
<input type='range' min='0.5' max='50' step='0.5' id='nat' style='accent-color:#fb923c' oninput='dv("nature",+this.value,"vnat",this.value)'></div>
<div class='air'>
<button id='air-in' onpointerdown='air("airIn",true)' onpointerup='air("airIn",false)' onpointerleave='air("airIn",false)'>&#9650; Air In</button>
<button id='air-out' onpointerdown='air("airOut",true)' onpointerup='air("airOut",false)' onpointerleave='air("airOut",false)'>&#9660; Air Out</button>
</div>
<div class='fb'><span>POS: <b id='fbp'>0</b></span><span>FORCE (auto): <b id='fbauto'>-</b></span><span>PRESENT: <b id='fbr'>-</b></span></div>
<div style='margin-top:16px;padding-top:12px;border-top:1px solid #1e1e1e;text-align:right'>
<button onclick='resetWifi()' style='padding:6px 12px;background:none;border:1px solid #3a1a1a;border-radius:6px;color:#555;font-size:11px;cursor:pointer'>Reset WiFi</button>
</div>
</div>
<script>
var st={activated:false,running:false,force:0,speed:0.5,depth:500,texture:0,nature:20};
var tmr={};
document.getElementById('ipad').textContent=location.host;
async function send(d){try{var r=await fetch('/api/ctrl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});st=await r.json();render();}catch(e){}}
function autoForce(s,d){return Math.max(100,Math.min(900,Math.round(100+0.08*s*d)));}
function render(){var on=st.running;document.getElementById('btn-run').className=on?'on':'';document.getElementById('btn-run').innerHTML=on?'&#9646;&#9646; Stop':'&#9654; Run';document.getElementById('sts').textContent=on?'running':'stopped';document.getElementById('fbauto').textContent=on?autoForce(st.speed,st.depth):'-';}
function toggleRun(){send({running:!st.running});}
function dv(k,v,vid,disp){document.getElementById(vid).textContent=disp;clearTimeout(tmr[k]);tmr[k]=setTimeout(()=>send({[k]:v}),80);if(st.running)document.getElementById('fbauto').textContent=autoForce(st.speed,st.depth);}
function air(k,v){document.getElementById(k==='airIn'?'air-in':'air-out').className=v?'on':'';send({[k]:v});}
function pollFb(){fetch('/api/feedback').then(r=>r.json()).then(f=>{document.getElementById('fbp').textContent=f.pos;document.getElementById('fbr').textContent=f.present?'✓':'-';}).catch(()=>{});setTimeout(pollFb,500);}
function resetWifi(){if(confirm('Delete WiFi config and restart in setup mode?'))fetch('/api/reset-wifi',{method:'POST'});}
fetch('/api/state').then(r=>r.json()).then(s=>{st=s;render();
  document.getElementById('spm').value=Math.round(s.speed*60);document.getElementById('vspm').textContent=Math.round(s.speed*60);
  document.getElementById('dep').value=s.depth;document.getElementById('vdep').textContent=s.depth;
  document.getElementById('tex').value=s.texture;document.getElementById('vtex').textContent=s.texture;
  document.getElementById('nat').value=s.nature;document.getElementById('vnat').textContent=s.nature;
});
pollFb();
</script></body></html>"""

def _ctl_json():
    return _json.dumps({'activated':_ctl['activated'],'running':_ctl['running'],
        'force':_ctl['force'],'speed':_ctl['speed'],'depth':_ctl['depth'],
        'offset':_ctl['offset'],'texture':_ctl['texture'],'nature':_ctl['nature']})

async def handle_web(reader, writer):
    try:
        req = await asyncio.wait_for(reader.read(512), timeout=3)
        s = req.decode('utf-8', 'ignore')
        line = s.split('\r\n', 1)[0].split(' ')
        method, path = line[0], (line[1] if len(line)>1 else '/')
        if method == 'GET' and path in ('/', '/index.html'):
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n')
            writer.write(_WEB_HTML)
        elif path == '/api/state':
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n')
            writer.write(_ctl_json().encode())
        elif path == '/api/feedback':
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n')
            writer.write(_json.dumps(_feedback).encode())
        elif method == 'POST' and path == '/api/ctrl':
            body = s.split('\r\n\r\n', 1)
            if len(body) > 1:
                try:
                    d = _json.loads(body[1])
                    for k in ('force','speed','depth','offset','texture','nature'):
                        if k in d: _ctl[k] = float(d[k])
                    for k in ('airOut','airIn'):
                        if k in d: _ctl[k] = bool(d[k])
                    if 'running' in d:
                        r = bool(d['running'])
                        _ctl['running'] = r
                        _ctl['activated'] = r
                        if r and _ctl['force'] < 100: _ctl['force'] = 600
                except: pass
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n')
            writer.write(_ctl_json().encode())
        elif method == 'POST' and path == '/api/reset-wifi':
            writer.write(b'HTTP/1.1 200 OK\r\n\r\n')
            await writer.drain()
            await writer.aclose()
            try:
                import os
                os.remove(boot.WIFI_FILE)
            except:
                pass
            machine.reset()
            return
        else:
            writer.write(b'HTTP/1.1 404 Not Found\r\n\r\n')
        await writer.drain()
    except Exception as e:
        print(f"[web] {e}")
    finally:
        try: await writer.aclose()
        except: pass

# ── Main ──────────────────────────────────────────────────────────────────
async def run():
    if boot.MODE == 'ap':
        screen_ap()
        gc.collect()
        print(f"[main] AP mode — connect to '{boot.AP_SSID}' and open http://{boot.IP}")
        asyncio.create_task(asyncio.start_server(handle_setup, '0.0.0.0', 80))
    else:
        # Re-apply power saving disable — boot.py retries reset it
        try:
            import network as _net
            _sta = _net.WLAN(_net.STA_IF)
            _sta.config(pm=_net.WLAN.PM_NONE)
        except: pass
        screen_waiting(boot.IP)
        print(f"[main] Bridge ready at {boot.IP}:{TCP_PORT}")
        asyncio.create_task(uart_sender())
        asyncio.create_task(uart_to_tcp())
        asyncio.create_task(asyncio.start_server(handle_bridge, '0.0.0.0', TCP_PORT))
        asyncio.create_task(asyncio.start_server(handle_web, '0.0.0.0', 80))
    while True:
        await asyncio.sleep(1)

asyncio.run(run())
