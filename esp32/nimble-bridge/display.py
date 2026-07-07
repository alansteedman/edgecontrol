import machine
import utime
import framebuf

# RGB565 colors (big-endian, RGB order)
BLACK  = 0x0000
WHITE  = 0xFFFF
CYAN   = 0x07FF
GREEN  = 0x07E0
ORANGE = 0xFD20
RED    = 0xF800
GRAY   = 0x8410
DKGRAY = 0x2945

_spi = None  # module-level singleton — survives across multiple ST7789() calls in same boot

class ST7789:
    # DollaTek 2.4" ILI9341 — 320x240 landscape, full frame (no pixel offset)
    W, H = 320, 240

    def __init__(self):
        global _spi
        if _spi is None:
            _spi = machine.SPI(1, baudrate=20_000_000, polarity=0, phase=0,
                               sck=machine.Pin(18), mosi=machine.Pin(23))
        self.spi = _spi
        self.dc  = machine.Pin(2,  machine.Pin.OUT)
        self.rst = machine.Pin(4,  machine.Pin.OUT)
        self._init()

    def _cmd(self, cmd, *data):
        self.dc(0)
        self.spi.write(bytes([cmd]))
        if data:
            self.dc(1)
            self.spi.write(bytes(data))

    def _init(self):
        self.rst(0); utime.sleep_ms(50)
        self.rst(1); utime.sleep_ms(150)
        self._cmd(0x01)                              # software reset
        utime.sleep_ms(150)
        self._cmd(0x11)                              # sleep out
        utime.sleep_ms(120)
        self._cmd(0xCF, 0x00, 0xC1, 0x30)           # power control B
        self._cmd(0xED, 0x64, 0x03, 0x12, 0x81)     # power on sequence
        self._cmd(0xE8, 0x85, 0x00, 0x78)           # driver timing A
        self._cmd(0xCB, 0x39, 0x2C, 0x00, 0x34, 0x02)  # power control A
        self._cmd(0xF7, 0x20)                        # pump ratio
        self._cmd(0xEA, 0x00, 0x00)                 # driver timing B
        self._cmd(0xC0, 0x23)                        # power control 1: VRH=4.60V
        self._cmd(0xC1, 0x10)                        # power control 2
        self._cmd(0xC5, 0x3E, 0x28)                 # VCOM 1
        self._cmd(0xC7, 0x86)                        # VCOM 2
        self._cmd(0x36, 0xE8)                        # MADCTL: MY=1, MX=1, MV=1 (180° flipped), BGR order
        self._cmd(0x3A, 0x55)                        # 16-bit RGB565
        self._cmd(0xB1, 0x00, 0x18)                 # frame rate ~79Hz
        self._cmd(0xB6, 0x08, 0x82, 0x27)           # display function control
        self._cmd(0xF2, 0x00)                        # 3-gamma disable
        self._cmd(0x26, 0x01)                        # gamma curve 1
        self._cmd(0xE0, 0x0F,0x31,0x2B,0x0C,0x0E,0x08,  # positive gamma
                         0x4E,0xF1,0x37,0x07,0x10,0x03,0x0E,0x09,0x00)
        self._cmd(0xE1, 0x00,0x0E,0x14,0x03,0x11,0x07,  # negative gamma
                         0x31,0xC1,0x48,0x08,0x0F,0x0C,0x31,0x36,0x0F)
        self._cmd(0x29)                              # display on
        utime.sleep_ms(100)

    def _window(self, x0, y0, x1, y1):
        self._cmd(0x2A, x0>>8, x0&0xFF, x1>>8, x1&0xFF)
        self._cmd(0x2B, y0>>8, y0&0xFF, y1>>8, y1&0xFF)
        self.dc(0); self.spi.write(b'\x2C'); self.dc(1)

    def fill(self, color, x=0, y=0, w=None, h=None):
        if w is None: w = self.W - x
        if h is None: h = self.H - y
        self._window(x, y, x+w-1, y+h-1)
        hi, lo = color >> 8, color & 0xFF
        chunk = bytes([hi, lo] * 128)
        total = w * h
        for _ in range(total // 128):
            self.spi.write(chunk)
        rem = total % 128
        if rem:
            self.spi.write(bytes([hi, lo] * rem))

    def text(self, s, x, y, fg=WHITE, bg=BLACK, scale=2):
        tmp = bytearray(128)
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
            self.spi.write(buf)

    def hline(self, y, color=DKGRAY):
        self.fill(color, x=0, y=y, w=self.W, h=1)
