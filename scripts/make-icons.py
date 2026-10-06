"""Generate the extension icons from the approved master artwork.

    python3 scripts/make-icons.py    # needs Pillow

Only resizes; the artwork is not altered. Resampling happens in premultiplied alpha (no dark
fringes around semi-transparent edges), with a box pre-reduction before Lanczos so the 16 px and
32 px versions stay crisp. Output PNGs carry no metadata, so they are byte-reproducible.
"""
from pathlib import Path

from PIL import Image

SOURCE = Path("assets/viewpace-icon-source.png")
OUT_DIR = Path("static/icons")
SIZES = (16, 32, 48, 128)


def main() -> None:
    master = Image.open(SOURCE).convert("RGBA")
    if master.width != master.height:
        raise SystemExit(f"{SOURCE} must be square, got {master.size}")
    premultiplied = master.convert("RGBa")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        icon = premultiplied.resize((size, size), Image.Resampling.LANCZOS, reducing_gap=3.0).convert("RGBA")
        out = OUT_DIR / f"icon-{size}.png"
        icon.save(out, format="PNG", optimize=True)
        print(f"{out}  {size}x{size}")


if __name__ == "__main__":
    main()
