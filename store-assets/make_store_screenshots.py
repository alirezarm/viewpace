"""Make Chrome Web Store screenshots (exactly 1280x800) from the raw captures.

    python3 store-assets/make_store_screenshots.py    # run from the repo root; needs Pillow

raw/ is never modified. Edits are limited to scaling, cropping, and redacting personal details
(profile photos). No marketing text, arrows or fake UI.
"""
from pathlib import Path

from PIL import Image, ImageDraw

RAW = Path("store-assets/raw")
OUT = Path("store-assets/store")
SIZE = (1280, 800)


def placeholder_avatar(img: Image.Image, center: tuple[int, int], radius: int) -> None:
    """Replace a profile photo with a neutral default avatar (grey disc, white silhouette)."""
    cx, cy = center
    s = 4  # draw supersampled for smooth edges
    d = radius * 2
    tile = Image.new("RGBA", (d * s, d * s), (0, 0, 0, 0))
    g = ImageDraw.Draw(tile)
    g.ellipse([0, 0, d * s - 1, d * s - 1], fill=(154, 160, 166, 255))
    r = d * s
    g.ellipse([r * 0.34, r * 0.18, r * 0.66, r * 0.50], fill=(255, 255, 255, 255))  # head
    g.ellipse([r * 0.18, r * 0.56, r * 0.82, r * 1.10], fill=(255, 255, 255, 255))  # shoulders
    mask = Image.new("L", (d * s, d * s), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, d * s - 1, d * s - 1], fill=255)
    tile.putalpha(Image.composite(tile.getchannel("A"), mask, mask))
    tile = tile.resize((d, d), Image.Resampling.LANCZOS)
    img.paste(tile, (cx - radius, cy - radius), tile)


def scale(img: Image.Image) -> Image.Image:
    if abs(img.width / img.height - SIZE[0] / SIZE[1]) > 1e-3:
        raise SystemExit(f"aspect ratio must be 16:10, got {img.size}")
    return img.resize(SIZE, Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # 01 and 03: captured at 1280x800 @2x, only scaled.
    for name in ("01-hero-adaptive-playback.png", "03-smart-pacing-in-player.png"):
        scale(Image.open(RAW / name).convert("RGB")).save(OUT / name, optimize=True)

    # 02: full-screen macOS capture (3024x1964). Redact both profile photos, then crop to 16:10:
    # from just below the black screen-capture strip (y=66) to just above the third-party ad in
    # the recommendations (starts at y~1870), keeping the YouTube logo (starts at x~142).
    shot = Image.open(RAW / "02-controls-popup-in-context.png").convert("RGB")
    placeholder_avatar(shot, center=(2906, 193), radius=22)  # Chrome profile icon
    placeholder_avatar(shot, center=(2944, 297), radius=34)  # YouTube account avatar
    left, top = 141, 66
    # The crop's left edge clips the macOS window buttons; paint that sliver with the tab-strip colour.
    ImageDraw.Draw(shot).rectangle([left, top, left + 12, 147], fill=shot.getpixel((170, 108)))
    width = shot.width - left
    crop = shot.crop((left, top, shot.width, top + round(width * 10 / 16)))
    scale(crop).save(OUT / "02-controls-popup-in-context.png", optimize=True)

    for p in sorted(OUT.glob("*.png")):
        print(p, Image.open(p).size)


if __name__ == "__main__":
    main()
