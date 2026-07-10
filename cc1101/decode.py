#!/usr/bin/env python3
"""Decode captured Tremblr pulses into 24-bit RCSwitch codes."""

import json

# Known codes from nogasm/tremblr-control
KNOWN = {
    16076992: "UP",
    16076812: "MID",
    16076848: "DOWN",
    16076803: "LEFT",
    16077568: "RIGHT",
}

def find_T(pulses):
    """Find the base pulse width T by looking for the most common short pulse."""
    widths = [d for s, d in pulses if 100 < d < 2000]
    if not widths:
        return None
    # Cluster into short and long — short ones are T, long ones are 3T
    widths.sort()
    # Find the valley between the two clusters
    short = [w for w in widths if w < widths[len(widths)//2]]
    return int(sum(short) / len(short)) if short else None

def decode_rcswitch(pulses, T, tolerance=0.4):
    """Decode RCSwitch protocol 1 bits from pulse pairs.

    Protocol 1:
      0 bit  = [1T HIGH, 3T LOW]
      1 bit  = [3T HIGH, 1T LOW]
      sync   = [1T HIGH, 31T LOW]
    """
    lo = T * (1 - tolerance)
    hi = T * (1 + tolerance)
    lo3 = T * 3 * (1 - tolerance)
    hi3 = T * 3 * (1 + tolerance)

    # Work through pairs of (HIGH, LOW) pulses
    i = 0
    # Find first HIGH pulse
    while i < len(pulses) and pulses[i][0] != 1:
        i += 1

    codes = []
    bits = []

    while i + 1 < len(pulses):
        h_state, h_dur = pulses[i]
        l_state, l_dur = pulses[i + 1]

        if h_state != 1 or l_state != 0:
            i += 1
            continue

        if lo < h_dur < hi and lo3 < l_dur < hi3:
            bits.append(0)
            i += 2
        elif lo3 < h_dur < hi3 and lo < l_dur < hi:
            bits.append(1)
            i += 2
        elif lo < h_dur < hi and l_dur > T * 20:
            # Sync pulse — end of packet
            if len(bits) == 24:
                code = 0
                for b in bits:
                    code = (code << 1) | b
                codes.append(code)
            bits = []
            i += 2
        else:
            # Unrecognised — skip
            bits = []
            i += 1

    # Catch last packet if no trailing sync
    if len(bits) == 24:
        code = 0
        for b in bits:
            code = (code << 1) | b
        codes.append(code)

    return codes

def most_common(lst):
    return max(set(lst), key=lst.count) if lst else None

with open("/home/alans/cc1101/tremblr_codes.json") as f:
    data = json.load(f)

print("Tremblr Code Decoder")
print("=" * 55)
print(f"{'Button':<12} {'Decoded code':<14} {'Match':<10} {'Packets'}")
print("-" * 55)

button_map = {}

for btn, info in data.items():
    pulses = [tuple(p) for p in info.get("pulses", [])]
    if not pulses:
        print(f"{btn:<12} FAILED")
        continue

    T = find_T(pulses)
    if not T:
        print(f"{btn:<12} Can't find T")
        continue

    codes = decode_rcswitch(pulses, T)
    if not codes:
        print(f"{btn:<12} No packets decoded  (T={T}μs)")
        continue

    best = most_common(codes)
    match = KNOWN.get(best, "UNKNOWN")
    button_map[btn] = {"code": best, "name": match, "T_us": T}
    print(f"{btn:<12} {best:<14} {match:<10} ({len(codes)} packets, T={T}μs)")

print()
print("Button map:")
for btn, info in button_map.items():
    print(f"  {btn} → {info['name']} (code {info['code']})")

# Save decoded map
import json as _json
out = "/home/alans/cc1101/tremblr_map.json"
with open(out, "w") as f:
    _json.dump(button_map, f, indent=2)
print(f"\nSaved to {out}")
