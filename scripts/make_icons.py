#!/usr/bin/env python3
"""Generate the Tauri icon set in src-tauri/icons/ from the project icon.png.

The source render places the app object on a flat grey backdrop. We remove that
backdrop (making it transparent) by flood-filling background-coloured pixels that
are connected to the image border — interior light pixels stay opaque — then emit
the PNG/ICNS/ICO files Tauri references in tauri.conf.json.

Needs numpy, scipy and Pillow. Run from the project root:
  python3 scripts/make_icons.py
"""

from __future__ import annotations

import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

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


def transparent_master(source: Path, tol: float = 70.0, margin: float = 0.06) -> Image.Image:
    """Return the icon object on a transparent background, squared and padded."""
    img = Image.open(source).convert("RGB")
    rgb = np.asarray(img).astype(np.float32)
    patch = 40
    corners = np.concatenate([
        rgb[:patch, :patch].reshape(-1, 3),
        rgb[:patch, -patch:].reshape(-1, 3),
        rgb[-patch:, :patch].reshape(-1, 3),
        rgb[-patch:, -patch:].reshape(-1, 3),
    ])
    bg = corners.mean(0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(2))

    # Background = background-coloured pixels connected to the image border.
    # Interior light pixels (e.g. text) are enclosed and stay opaque.
    bg_mask = dist < tol
    labels, _ = ndimage.label(bg_mask)
    border = set(np.unique(np.concatenate(
        [labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]
    ))) - {0}
    foreground = ~np.isin(labels, list(border))

    # Keep only the largest opaque blob to drop stray shadow remnants.
    fg_labels, n = ndimage.label(foreground)
    if n > 0:
        sizes = ndimage.sum(np.ones_like(fg_labels), fg_labels, range(1, n + 1))
        foreground = fg_labels == (1 + int(np.argmax(sizes)))

    alpha = np.where(foreground, 255, 0).astype(np.uint8)
    out = Image.fromarray(np.dstack([np.asarray(img), alpha]), "RGBA")
    out.putalpha(out.split()[3].filter(ImageFilter.GaussianBlur(1.0)))  # feather edges

    out = out.crop(out.split()[3].getbbox())
    side = round(max(out.size) * (1 + margin * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2), out)
    return canvas


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
    master = transparent_master(SOURCE)
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
