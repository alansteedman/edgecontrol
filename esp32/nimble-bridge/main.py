import socket
import machine
import utime
import _thread
import gc

# ── UART to NimbleStroker ─────────────────────────────────────────────────
# Cross-connect: ESP32 TX → Nimble RX,  ESP32 RX ← Nimble TX
# Adjust TX_PIN / RX_PIN to match your RJ12 wiring
TX_PIN  = 17   # GPIO17 → Nimble RX (orange wire?)
RX_PIN  = 16   # GPIO16 ← Nimble TX
BAUD    = 115200

# ── TCP server ────────────────────────────────────────────────────────────
TCP_PORT = 8765

# ── Display ───────────────────────────────────────────────────────────────
# Set DISPLAY_ENABLED = True once you've confirmed the bridge works
DISPLAY_ENABLED = False

uart = machine.UART(2, baudrate=BAUD, tx=TX_PIN, rx=RX_PIN, bits=8, parity=None, stop=1, rxbuf=256)

# Shared state
_client    = None
_client_lock = _thread.allocate_lock()

def set_client(sock):
    global _client
    with _client_lock:
        _client = sock

def get_client():
    with _client_lock:
        return _client

# ── Thread: UART RX → TCP (feedback from Nimble to Pi) ───────────────────
def uart_to_tcp():
    buf = bytearray()
    while True:
        data = uart.read(64)
        if data:
            buf += data
            # Forward complete 7-byte packets only
            while len(buf) >= 7:
                c = get_client()
                if c:
                    try:
                        c.write(bytes(buf[:7]))
                    except:
                        set_client(None)
                buf = buf[7:]
        utime.sleep_ms(5)

# ── TCP server: accept connections, forward bytes to UART ─────────────────
def tcp_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', TCP_PORT))
    srv.listen(1)
    print(f"[bridge] TCP listening on port {TCP_PORT}")

    while True:
        try:
            conn, addr = srv.accept()
            conn.settimeout(2.0)
            print(f"[bridge] Pi connected from {addr[0]}")
            set_client(conn)
            update_display('connected', addr[0])

            # Read loop: TCP RX → UART TX
            buf = bytearray()
            while True:
                try:
                    chunk = conn.recv(64)
                    if not chunk:
                        break
                    buf += chunk
                    # Forward complete 7-byte packets
                    while len(buf) >= 7:
                        uart.write(bytes(buf[:7]))
                        buf = buf[7:]
                except OSError as e:
                    if e.args[0] == 110:  # ETIMEDOUT — fine, just loop
                        continue
                    break

        except Exception as e:
            print(f"[bridge] conn error: {e}")

        set_client(None)
        print("[bridge] Pi disconnected")
        update_display('waiting', '')
        gc.collect()

# ── Display ───────────────────────────────────────────────────────────────
def update_display(status, info=''):
    if not DISPLAY_ENABLED:
        return
    # Display code goes here once display driver is set up
    pass

def init_display():
    if not DISPLAY_ENABLED:
        return
    # Display init goes here
    pass

# ── Setup HTTP server (AP mode only) ─────────────────────────────────────
def setup_server():
    from boot import save_wifi, MODE, IP
    if MODE != 'ap':
        return

    import network
    print(f"[setup] AP mode — connect to '{boot.AP_SSID}' and open http://{IP}")

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', 80))
    srv.listen(3)

    FORM = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NimbleBridge Setup</title>
<style>body{font-family:sans-serif;max-width:360px;margin:40px auto;padding:0 16px;background:#0f0f0f;color:#e0e0e0}
h2{color:#4fc3f7}label{display:block;margin:12px 0 4px;font-size:13px;color:#888}
input{width:100%;box-sizing:border-box;padding:10px;background:#1a1a1a;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-size:15px}
button{margin-top:18px;width:100%;padding:12px;background:#1a3a6a;color:#4fc3f7;border:1px solid #2a5aaa;border-radius:6px;font-size:15px;cursor:pointer}</style></head>
<body><h2>NimbleBridge WiFi Setup</h2>
<form method="POST" action="/save">
<label>WiFi Network (SSID)</label><input name="ssid" type="text" autocomplete="off">
<label>Password</label><input name="pass" type="password">
<button type="submit">Save &amp; Connect</button>
</form></body></html>"""

    OK_PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Saved</title>
<style>body{font-family:sans-serif;max-width:360px;margin:40px auto;padding:0 16px;background:#0f0f0f;color:#e0e0e0}h2{color:#4ade80}</style></head>
<body><h2>&#10003; Saved</h2><p>NimbleBridge is connecting to your network and will restart. It will appear on your local network in a few seconds.</p></body></html>"""

    while True:
        try:
            conn, _ = srv.accept()
            req = b''
            while True:
                chunk = conn.recv(512)
                if not chunk or b'\r\n\r\n' in req:
                    break
                req += chunk

            req_str = req.decode('utf-8', 'ignore')
            if req_str.startswith('POST /save'):
                # Parse body
                body = req_str.split('\r\n\r\n', 1)[-1] if '\r\n\r\n' in req_str else ''
                params = {}
                for part in body.strip().split('&'):
                    if '=' in part:
                        k, v = part.split('=', 1)
                        params[k] = v.replace('+', ' ')
                ssid = _urldecode(params.get('ssid', ''))
                pw   = _urldecode(params.get('pass', ''))
                save_wifi(ssid, pw)
                conn.send(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n' + OK_PAGE.encode())
                conn.close()
                utime.sleep(2)
                machine.reset()
            else:
                conn.send(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n' + FORM.encode())
                conn.close()
        except Exception as e:
            print(f"[setup] {e}")

def _urldecode(s):
    out = []
    i = 0
    while i < len(s):
        if s[i] == '%' and i + 2 < len(s):
            out.append(chr(int(s[i+1:i+3], 16)))
            i += 3
        else:
            out.append(s[i])
            i += 1
    return ''.join(out)

# ── Start ─────────────────────────────────────────────────────────────────
import boot

init_display()
update_display('waiting', '')

if boot.MODE == 'ap':
    # Run setup server on main thread, no bridge needed yet
    print("[main] AP mode — running setup server")
    setup_server()
else:
    # Start UART→TCP feedback thread
    _thread.start_new_thread(uart_to_tcp, ())
    # Run TCP bridge on main thread
    print(f"[main] Bridge ready — connect Pi to {boot.IP}:{TCP_PORT}")
    tcp_server()
