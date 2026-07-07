import machine
import time

print("[main] Starting diagnostic...")
time.sleep(0.5)

# Backlight on
machine.Pin(32, machine.Pin.OUT).value(1)
print("[main] Backlight on")

try:
    from display import ST7789, BLACK, WHITE, GREEN, CYAN
    print("[main] display imported OK")
    disp = ST7789()
    print("[main] ST7789 init OK")
    disp.fill(BLACK, 0, 0, 170, 320)
    print("[main] fill OK")
    disp.text("Display OK!", 10, 100, GREEN, BLACK, 2)
    disp.text("No crash :)", 10, 130, WHITE, BLACK, 2)
    disp.text(f"Mode:{boot.MODE}", 10, 160, CYAN, BLACK, 1)
    print("[main] text rendered OK")
except Exception as e:
    print(f"[main] CRASH: {e}")
    import sys
    sys.print_exception(e)

print("[main] Done — looping")
while True:
    time.sleep(5)
    print("[main] alive")
