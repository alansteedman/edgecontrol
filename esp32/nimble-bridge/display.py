import machine
import utime
import framebuf

# RGB565 colors (big-endian for ST7789)
BLACK  = 0x0000
WHITE  = 0xFFFF
CYAN   = 0x07FF
GREEN  = 0x07E0
ORANGE = 0xFD20
RED    = 0xF800
GRAY   = 0x8410
DKGRAY = 0x2945

class ST7789:
    # ideaspark 1.9" 170x320 — the ST7789 chip has 240x320 RAM;
    # this panel is offset 35 pixels in X
    W, H = 170, 320
    X_OFF, Y_OFF = 35, 0

    def __init__(self):
        self.spi = machine.SPI(1, baudrate=20_000_000, polarity=0, phase=0,
                               sck=machine.Pin(18), mosi=machine.Pin(23))
        self.cs  = machine.Pin(15, machine.Pin.OUT)
        self.dc  = machine.Pin(2,  machine.Pin.OUT)
        self.rst = machine.Pin(4,  machine.Pin.OUT)
        self.cs(1)
        self._init_display()

    def _cmd(self, cmd, *data):
        self.cs(0); self.dc(0)
        self.spi.write(bytes([cmd]))
        if data:
            self.dc(1)
            self.spi.write(bytes(data))
        self.cs(1)

    def _init_display(self):
        self.rst(0); utime.sleep_ms(50)
        self.rst(1); utime.sleep_ms(150)
        self._cmd(0x01)                              # software reset
        utime.sleep_ms(150)
        self._cmd(0x11)                              # sleep out
        utime.sleep_ms(500)
        self._cmd(0x3A, 0x55)                        # 16-bit RGB565 color
        self._cmd(0x36, 0x00)                        # portrait, RGB order
        self._cmd(0xB2, 0x0C,0x0C,0x00,0x33,0x33)   # porch control
        self._cmd(0xB7, 0x35)                        # gate control
        self._cmd(0xBB, 0x19)                        # VCOMS
        self._cmd(0xC0, 0x2C)                        # LCM control
        self._cmd(0xC2, 0x01); self._cmd(0xC3, 0x12) # VDV/VRH
        self._cmd(0xC4, 0x20)                        # VDV set
        self._cmd(0xC6, 0x0F)                        # frame rate 60Hz
        self._cmd(0xD0, 0xA4, 0xA1)                  # power control
        self._cmd(0x29)                              # display on
        utime.sleep_ms(100)

    def _window(self, x0, y0, x1, y1):
        x0 += self.X_OFF; x1 += self.X_OFF
        y0 += self.Y_OFF; y1 += self.Y_OFF
        self._cmd(0x2A, x0>>8, x0&0xFF, x1>>8, x1&0xFF)
        self._cmd(0x2B, y0>>8, y0&0xFF, y1>>8, y1&0xFF)
        self.cs(0); self.dc(0); self.spi.write(b'\x2C'); self.dc(1)

    def fill(self, color, x=0, y=0, w=None, h=None):
        if w is None: w = self.W - x
        if h is None: h = self.H - y
        self._window(x, y, x+w-1, y+h-1)
        hi, lo = color >> 8, color & 0xFF
        chunk = bytes([hi, lo] * 128)
        total = w * h
        self.cs(0)
        for _ in range(total // 128):
            self.spi.write(chunk)
        rem = total % 128
        if rem:
            self.spi.write(bytes([hi, lo] * rem))
        self.cs(1)

    def text(self, s, x, y, fg=WHITE, bg=BLACK, scale=2):
        """Draw a string using the built-in 8×8 font, scaled up by `scale`."""
        tmp = bytearray(128)  # 8×8 pixels × 2 bytes
        fb  = framebuf.FrameBuffer(tmp, 8, 8, framebuf.RGB565)
        cw  = 8 * scale
        ch  = 8 * scale
        fh  = bytes([fg >> 8, fg & 0xFF])
        bh  = bytes([bg >> 8, bg & 0xFF])
        for ci, char in enumerate(s):
            cx = x + ci * cw
            if cx + cw > self.W:
                break
            fb.fill(0)
            fb.text(char, 0, 0, 0xFFFF)
            buf = bytearray(cw * ch * 2)
            out = 0
            for py in range(8):
                # build one source row: cw pixels of fg or bg
                row = bytearray()
                for px in range(8):
                    i = (py * 8 + px) * 2
                    row += fh if (tmp[i] | tmp[i+1]) else bh
                    if scale > 1:
                        row += fh * (scale-1) if (tmp[i] | tmp[i+1]) else bh * (scale-1)
                for _ in range(scale):
                    buf[out:out+len(row)] = row
                    out += len(row)
            self._window(cx, y, cx+cw-1, y+ch-1)
            self.cs(0)
            self.spi.write(buf)
            self.cs(1)

    def hline(self, y, color=DKGRAY):
        self.fill(color, x=0, y=y, w=self.W, h=1)
