"""
crop-clueless-avatars.py
Trims transparent background from clueless bot avatar webp files,
squares and centres the crop on the robot circle content with padding,
then saves back to the same file at 512x512 (RGBA, transparency preserved).

Padding ensures the CSS border-radius clip cuts through transparent space
rather than through the robot's decorative ring, giving a clean edge.
"""

from PIL import Image
import os

AVATAR_DIR = os.path.join(os.path.dirname(__file__), '..', 'Images', 'bot-avatars', 'clueless')
OUTPUT_SIZE = 512
# Padding added around the detected content bbox before squaring.
# ~5% of 1024px = 52px → robot fills ~90% of final canvas, leaving clean
# transparent breathing room so the CSS circle clip is smooth.
PADDING = 52
ALPHA_THRESHOLD = 32  # alpha < this → transparent background pixel

def find_content_bbox(img: Image.Image):
    """Return (x0, y0, x1, y1) of non-transparent content using alpha channel."""
    rgba = img.convert('RGBA')
    w, h = rgba.size
    pixels = rgba.load()

    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if pixels[x, y][3] >= ALPHA_THRESHOLD:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1

def process(path: str):
    img = Image.open(path).convert('RGBA')
    w, h = img.size

    x0, y0, x1, y1 = find_content_bbox(img)

    # expand by padding, clamp to image bounds
    x0 = max(0, x0 - PADDING)
    y0 = max(0, y0 - PADDING)
    x1 = min(w - 1, x1 + PADDING)
    y1 = min(h - 1, y1 + PADDING)

    # make square: expand the shorter side equally around centre
    cw = x1 - x0
    ch = y1 - y0
    side = max(cw, ch)
    cx = (x0 + x1) // 2
    cy = (y0 + y1) // 2

    sx0 = max(0, cx - side // 2)
    sy0 = max(0, cy - side // 2)
    sx1 = sx0 + side
    sy1 = sy0 + side

    if sx1 > w: sx0 -= sx1 - w; sx1 = w
    if sy1 > h: sy0 -= sy1 - h; sy1 = h

    cropped = img.crop((sx0, sy0, sx1, sy1))
    resized = cropped.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)

    resized.save(path, 'WEBP', quality=92, lossless=False)
    fill_pct = round((x1 - x0 - 2*PADDING) / side * 100)
    print(f'  {os.path.basename(path):30s}  content={x1-x0-2*PADDING}px  canvas={side}px  fill={fill_pct}%')

def main():
    files = sorted(f for f in os.listdir(AVATAR_DIR) if f.lower().endswith('.webp'))
    print(f'Processing {len(files)} files in {AVATAR_DIR}\n')
    for f in files:
        process(os.path.join(AVATAR_DIR, f))
    print('\nDone.')

if __name__ == '__main__':
    main()
