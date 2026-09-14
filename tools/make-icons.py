#!/usr/bin/env python3
"""Generate the douyin-local app icons.

Pure standard library (zlib + struct), no Pillow needed. Renders a rounded
square with a cyan -> red gradient and a white play glyph, then box-downsamples
for clean anti-aliased edges.

Usage:  python tools/make-icons.py
Outputs:
  fnos/douyin-local/ICON.PNG                        (64x64)
  fnos/douyin-local/ICON_256.PNG                    (256x256)
  fnos/douyin-local/app/ui/images/icon_64.png       (64x64)
  fnos/douyin-local/app/ui/images/icon_256.png      (256x256)
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4  # supersampling factor

CYAN = (0x25, 0xF4, 0xEE)
RED = (0xFE, 0x2C, 0x55)
WHITE = (0xFF, 0xFF, 0xFF)


def write_png(path, width, height, rows):
    """rows: list of bytearray, each of length width*4 (RGBA)."""
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        payload = struct.pack(">I", len(data)) + tag + data
        return payload + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    blob = b"\x89PNG\r\n\x1a\n"
    blob += chunk(b"IHDR", header)
    blob += chunk(b"IDAT", zlib.compress(raw, 9))
    blob += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(blob)


def render(size):
    """Render at size*SS then downsample by SS. Returns RGBA rows."""
    big = size * SS
    radius = big * 0.225
    cx = (big - 1) / 2.0

    # Play triangle: pointing right, optically centred (nudged right a little).
    tri_h = big * 0.42
    tri_w = tri_h * 0.87
    ax, ay = cx - tri_w * 0.34, (big - tri_h) / 2.0 + tri_h * 0.06
    bx, by = cx - tri_w * 0.34, ay + tri_h
    px, py = ax + tri_w, ay + tri_h / 2.0

    hi = big - 1
    buf = []
    for y in range(big):
        row = bytearray(big * 4)
        for x in range(big):
            # rounded-rect mask
            dx = max(radius - x, x - (hi - radius), 0.0)
            dy = max(radius - y, y - (hi - radius), 0.0)
            if dx * dx + dy * dy > radius * radius:
                continue

            # diagonal gradient cyan -> red
            t = (x + y) / (2.0 * hi)
            r = int(CYAN[0] + (RED[0] - CYAN[0]) * t)
            g = int(CYAN[1] + (RED[1] - CYAN[1]) * t)
            b = int(CYAN[2] + (RED[2] - CYAN[2]) * t)

            # inside the triangle -> white
            d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
            d2 = (x - px) * (by - py) - (bx - px) * (y - py)
            d3 = (x - ax) * (py - ay) - (px - ax) * (y - ay)
            neg = d1 < 0 or d2 < 0 or d3 < 0
            pos = d1 > 0 or d2 > 0 or d3 > 0
            if not (neg and pos):
                r, g, b = WHITE

            off = x * 4
            row[off] = r
            row[off + 1] = g
            row[off + 2] = b
            row[off + 3] = 255
        buf.append(row)

    # box downsample
    out = []
    for y in range(size):
        row = bytearray(size * 4)
        for x in range(size):
            sr = sg = sb = sa = 0
            for oy in range(SS):
                source = buf[y * SS + oy]
                for ox in range(SS):
                    off = (x * SS + ox) * 4
                    a = source[off + 3]
                    sr += source[off] * a
                    sg += source[off + 1] * a
                    sb += source[off + 2] * a
                    sa += a
            off = x * 4
            if sa:
                row[off] = min(sr // sa, 255)
                row[off + 1] = min(sg // sa, 255)
                row[off + 2] = min(sb // sa, 255)
            row[off + 3] = sa // (SS * SS)
        out.append(row)
    return out


def main():
    targets = [
        (64, "fnos/douyin-local/ICON.PNG"),
        (256, "fnos/douyin-local/ICON_256.PNG"),
        (64, "fnos/douyin-local/app/ui/images/icon_64.png"),
        (256, "fnos/douyin-local/app/ui/images/icon_256.png"),
    ]
    for size, rel in targets:
        path = os.path.join(ROOT, rel)
        write_png(path, size, size, render(size))
        print(f"wrote {rel} ({size}x{size})")


if __name__ == "__main__":
    main()
