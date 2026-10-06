"""Compose the Chrome Web Store screenshot graphics (1280x800, full bleed, square corners).

    python3 store-assets/make_store_graphics.py    # run from the repo root; needs Pillow

Layout: a ViewPace-branded text band across the top, the real product screenshot filling the
rest edge to edge. Screenshots come from store-assets/raw/ (never modified) and are only cropped
and scaled; no UI is added or altered. Font: Plus Jakarta Sans (SIL OFL, see fonts/OFL.txt).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RAW = Path("store-assets/raw")
OUT = Path("store-assets/final")
ICON = Path("static/icons/icon-128.png")
FONT = "store-assets/fonts/PlusJakartaSans-Variable.ttf"

W, H = 1280, 800
BAND = 200  # height of the text band; the screenshot fills the remaining 1280x600
MARGIN = 64

# Brand colours sampled from the ViewPace icon's gradient, darkened for a quiet background.
BG_LEFT = (12, 22, 66)  # deep blue
BG_RIGHT = (44, 20, 94)  # deep violet
HEADLINE = (255, 255, 255)
SUPPORT = (176, 198, 255)  # light periwinkle, from the icon's cyan-blue end

GRAPHICS = [
    {
        "out": "01-hero.png",
        "src": "01-hero-adaptive-playback.png",
        # Right part of the player around the ViewPace badge (2560x1600 capture), zoomed so the
        # badge reads clearly.
        "crop": (960, 600, 2560, 1350),
        "headline": "YouTube at the right speed, automatically.",
        "support": "Easy parts faster. Harder parts slower.",
    },
    {
        "out": "02-controls.png",
        "src": "02-controls-popup-in-context.png",
        # Toolbar (full URL), YouTube logo and the ViewPace panel over the video (3024x1964 capture).
        "crop": (141, 148, 3024, 1500),
        "headline": "Choose your pace. ViewPace does the rest.",
        "support": None,
    },
    {
        "out": "03-smart-pacing.png",
        "src": "03-smart-pacing-in-player.png",
        # Whole player (text-heavy slide: a tighter crop would cut sentences), badge bottom right.
        "crop": (0, 172, 2560, 1372),
        "headline": "Understands what's being said. On your device.",
        "support": "Smart Pacing uses Chrome's on-device AI.",
    },
]


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_axes([weight])
    return f


def fitted(text: str, max_width: int, size: int, weight: int) -> ImageFont.FreeTypeFont:
    """Largest font size (down from `size`) at which `text` fits on one line."""
    while size > 20:
        f = font(size, weight)
        if f.getlength(text) <= max_width:
            return f
        size -= 1
    return font(size, weight)


def band() -> Image.Image:
    """Horizontal blue-to-violet gradient."""
    g = Image.new("RGB", (W, 1))
    for x in range(W):
        t = x / (W - 1)
        g.putpixel((x, 0), tuple(round(a + (b - a) * t) for a, b in zip(BG_LEFT, BG_RIGHT)))
    return g.resize((W, BAND))


def compose(spec: dict) -> Image.Image:
    canvas = Image.new("RGB", (W, H))
    canvas.paste(band(), (0, 0))

    shot = Image.open(RAW / spec["src"]).convert("RGB").crop(spec["crop"])
    if abs(shot.width / shot.height - W / (H - BAND)) > 2e-3:
        raise SystemExit(f"{spec['src']}: crop must be {W}:{H - BAND}, got {shot.size}")
    canvas.paste(shot.resize((W, H - BAND), Image.Resampling.LANCZOS), (0, BAND))

    icon_size = 64
    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    text_x = MARGIN + icon_size + 24
    max_text = W - text_x - MARGIN

    draw = ImageDraw.Draw(canvas)
    head = fitted(spec["headline"], max_text, 50, 800)
    if spec["support"]:
        sub = fitted(spec["support"], max_text, 28, 500)
        gap = 14
        h_head = head.getbbox(spec["headline"])[3]
        h_sub = sub.getbbox(spec["support"])[3]
        top = (BAND - (h_head + gap + h_sub)) // 2
        draw.text((text_x, top), spec["headline"], font=head, fill=HEADLINE)
        draw.text((text_x, top + h_head + gap), spec["support"], font=sub, fill=SUPPORT)
    else:
        h_head = head.getbbox(spec["headline"])[3]
        draw.text((text_x, (BAND - h_head) // 2), spec["headline"], font=head, fill=HEADLINE)
    canvas.paste(icon, (MARGIN, (BAND - icon_size) // 2), icon)
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for spec in GRAPHICS:
        img = compose(spec)
        img.save(OUT / spec["out"], optimize=True)
        print(OUT / spec["out"], img.size)


if __name__ == "__main__":
    main()
