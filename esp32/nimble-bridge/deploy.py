#!/usr/bin/env python3
"""Deploy files to NimbleBridge ESP32 via raw REPL (no mpremote reset)."""

import serial, time, sys, os, glob

PORT_GLOB = '/dev/cu.usbserial-*'
BAUD = 115200
CHUNK = 512

FILES = ['display.py', 'boot.py', 'main.py']

def find_port():
    ports = glob.glob(PORT_GLOB)
    if not ports:
        print("No serial port found"); sys.exit(1)
    return ports[0]

def read_until(s, marker, timeout=5.0):
    """Read from serial until marker bytes appear (or timeout)."""
    buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = s.read(64)
        if b:
            buf += b
            if marker in buf:
                return buf
    return buf  # timed out

def interrupt_to_repl(s):
    """Interrupt running code, land at >>> normal REPL prompt."""
    print("Interrupting...", end='', flush=True)
    for _ in range(20):
        s.write(b'\x03')
        time.sleep(0.1)
    time.sleep(0.5)
    # Drain whatever came out
    s.timeout = 0.3
    while s.read(256):
        pass
    s.timeout = 1
    # Check for >>>
    s.write(b'\r\n')
    resp = read_until(s, b'>>>', timeout=2)
    if b'>>>' in resp:
        print(" ok")
        return True
    print(f" FAILED (got {resp[:30]})")
    return False

class RawREPL:
    """Context manager for MicroPython raw REPL session."""

    def __init__(self, s):
        self.s = s

    def __enter__(self):
        # Enter raw REPL with Ctrl+A
        self.s.write(b'\x01')
        resp = read_until(self.s, b'>', timeout=3)
        if b'raw REPL' not in resp and b'>' not in resp:
            raise RuntimeError(f"Could not enter raw REPL: {resp[:40]}")
        return self

    def __exit__(self, *_):
        # Return to normal REPL with Ctrl+B
        self.s.write(b'\x02')
        time.sleep(0.3)
        self.s.timeout = 0.2
        while self.s.read(256):
            pass
        self.s.timeout = 1

    def exec(self, cmd, timeout=3.0):
        """Execute one command in raw REPL. Returns (stdout, stderr)."""
        # Send command + Ctrl+D
        self.s.write(cmd.encode() + b'\x04')
        # Response format: OK<stdout>\x04<stderr>\x04>
        # Read until we see the trailing \x04>
        buf = b''
        deadline = time.time() + timeout
        while time.time() < deadline:
            b = self.s.read(128)
            if b:
                buf += b
            # Look for OK...x04...x04> pattern
            if buf.startswith(b'OK') and buf.count(b'\x04') >= 2:
                break
            if buf.count(b'\x04') >= 2:
                break
        if not buf.startswith(b'OK'):
            return None, buf  # error — no OK
        rest = buf[2:]
        parts = rest.split(b'\x04')
        stdout = parts[0] if len(parts) > 0 else b''
        stderr = parts[1].strip() if len(parts) > 1 else b''
        return stdout, stderr

def upload_file(repl, path):
    name = os.path.basename(path)
    with open(path, 'rb') as f:
        content = f.read()
    print(f"  {name} ({len(content)}b)", end='', flush=True)

    out, err = repl.exec(f"f=open('{name}','wb')", timeout=3)
    if out is None or err:
        print(f" FAILED (open): {err}")
        return False

    chunks = list(range(0, len(content), CHUNK))
    for i in chunks:
        chunk = content[i:i+CHUNK]
        out, err = repl.exec(f"f.write({repr(chunk)})", timeout=5)
        if out is None or err:
            print(f" FAILED chunk {i//CHUNK}: out={out} err={err}")
            return False
        print('.', end='', flush=True)

    out, err = repl.exec("f.close();print('DONE')", timeout=3)
    if out is None or b'DONE' not in out or err:
        print(f" FAILED (close): out={out} err={err}")
        return False

    # Verify size
    out2, _ = repl.exec(f"import os;print(os.stat('{name}')[6])", timeout=2)
    size = out2.strip() if out2 else b'?'
    if size and size.isdigit() and int(size) != len(content):
        print(f" SIZE MISMATCH: expected {len(content)}, got {size}")
        return False

    print(f" ok ({size.decode()}b)")
    return True

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    files = [os.path.join(script_dir, f) for f in FILES]
    missing = [f for f in files if not os.path.exists(f)]
    if missing:
        print(f"Missing: {missing}"); sys.exit(1)

    port = find_port()
    print(f"Connecting to {port}...")
    s = serial.Serial(port, BAUD, timeout=1)
    time.sleep(0.5)

    if not interrupt_to_repl(s):
        sys.exit(1)

    print("Uploading:")
    try:
        with RawREPL(s) as repl:
            for f in files:
                if not upload_file(repl, f):
                    sys.exit(1)
    except Exception as e:
        print(f"Raw REPL error: {e}")
        s.close(); sys.exit(1)

    # Reset via normal REPL
    print("Resetting...", end='', flush=True)
    s.write(b'import machine; machine.reset()\r\n')
    time.sleep(1)
    s.close()
    print(" done\nDeploy complete.")

if __name__ == '__main__':
    main()
