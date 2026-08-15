#!/usr/bin/env python3
"""Generate the PWA icons in public/.

Placeholder art, deliberately: a peg on a wall, which is what a *knag* is. There is
no brand asset for this project yet, and a manifest pointing at a 404 is worse than
a plain mark — iOS silently falls back to a screenshot of the page, which looks like
a bug on the home screen.

Regenerate with:  python3 scripts/make-icons.py     (needs Pillow)

Replace the output the day real artwork exists; nothing depends on how this looks.
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (17, 17, 17)  # #111111 — must match manifest theme_color and the shell
FG = (232, 232, 232)  # #e8e8e8
PEG = (224, 160, 92)

OUT = Path(__file__).resolve().parent.parent / "public"


def draw(size: int) -> Image.Image:
    """A wall line with a peg driven into it, and something hanging from the peg."""
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    u = size / 32  # design on a 32-unit grid, then scale

    # Maskable icons get cropped to a circle on Android, so everything stays inside
    # the middle 80%.
    d.rounded_rectangle([2 * u, 2 * u, 30 * u, 30 * u], radius=6 * u, outline=FG, width=int(u))

    # The wall.
    d.line([8 * u, 11 * u, 24 * u, 11 * u], fill=FG, width=int(1.5 * u))

    # The peg, driven in and angled up.
    d.line([13 * u, 11 * u, 19 * u, 15 * u], fill=PEG, width=int(2 * u))
    d.ellipse([18 * u, 14 * u, 21 * u, 17 * u], fill=PEG)

    # Two things hung on it.
    d.line([16 * u, 13 * u, 16 * u, 23 * u], fill=FG, width=int(u))
    d.line([19.5 * u, 16 * u, 19.5 * u, 25 * u], fill=FG, width=int(u))

    return img


if __name__ == "__main__":
    for size in (192, 512):
        path = OUT / f"icon-{size}.png"
        draw(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(OUT.parent)} ({path.stat().st_size} bytes)")
