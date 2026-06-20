#!/usr/bin/env python3
"""Generate the Tauri icon set in src-tauri/icons/ from the project icon.png.

The source render places the app object on a flat grey backdrop, so we crop to
the object (by distance from the sampled background colour), apply a rounded
alpha mask, and emit the PNG/ICNS/ICO files Tauri references in tauri.conf.json.

Run from the project root:  python3 scripts/make_icons.py
"""

from __future__ import annotations

import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "icon.png"
ICONS_DIR = ROOT / "src-tauri" / "icons"

# Tauri PNG icons referenced by tauri.conf.json (must be RGBA).
PNG_SIZES = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256}

# Filenames Apple's iconutil expects inside an .iconset directory.
ICONSET_SIZES = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]

# PNG-backed ICNS slots, used when iconutil is unavailable (non-macOS CI).
ICNS_ENTRIES = [
    ("icp4", 16),
    ("icp5", 32),
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
]


def rounded_master(source: Path, tol: float = 90.0, radius_ratio: float = 0.20) -> Image.Image:
    rgb = np.asarray(Image.open(source).convert("RGB")).astype(np.float32)
    patch = 50
    corners = np.concatenate([
        rgb[:patch, :patch].reshape(-1, 3),
        rgb[:patch, -patch:].reshape(-1, 3),
        rgb[-patch:, :patch].reshape(-1, 3),
        rgb[-patch:, -patch:].reshape(-1, 3),
    ])
    bg = corners.mean(0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(2))
    ys, xs = np.where(dist > tol)
    if xs.size == 0:
        raise ValueError("could not locate the icon object against the background")

    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    side = max(right - left, bottom - top)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    img = Image.open(source).convert("RGBA")
    l = max(0, min(cx - side // 2, img.width - side))
    t = max(0, min(cy - side // 2, img.height - side))
    crop = img.crop((l, t, l + side, t + side))

    scale = 4
    radius = round(side * radius_ratio)
    mask_big = Image.new("L", (side * scale, side * scale), 0)
    ImageDraw.Draw(mask_big).rounded_rectangle(
        (0, 0, side * scale - 1, side * scale - 1), radius=radius * scale, fill=255
    )
    crop.putalpha(mask_big.resize((side, side), Image.Resampling.LANCZOS))
    return crop


def write_icns(master: Image.Image, output: Path) -> None:
    iconset = output.parent / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    for size, name in ICONSET_SIZES:
        master.resize((size, size), Image.Resampling.LANCZOS).save(iconset / name, "PNG")

    if shutil.which("iconutil"):
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(output)], check=True
        )
        shutil.rmtree(iconset)
        return

    # Fallback: assemble a PNG-backed .icns accepted by modern macOS.
    payload = b""
    for code, size in ICNS_ENTRIES:
        buf = iconset / f"_{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(buf, "PNG")
        data = buf.read_bytes()
        payload += code.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    output.write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)
    shutil.rmtree(iconset)


def main() -> None:
    master = rounded_master(SOURCE)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    for name, size in PNG_SIZES.items():
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICONS_DIR / name, "PNG")

    write_icns(master, ICONS_DIR / "icon.icns")
    master.resize((256, 256), Image.Resampling.LANCZOS).save(
        ICONS_DIR / "icon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote icons to {ICONS_DIR}")


if __name__ == "__main__":
    main()
