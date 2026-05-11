"""
crop-clueless-avatars.py
Trims white background from clueless bot avatar webp files,
squares and centres the crop on the robot circle content,
then saves back to the same file at 512x512.
"""

from PIL import Image
import os

AVATAR_DIR = os.path.join(os.path.dirname(__file__), '..', 'Images', 'bot-avatars', 'clueless')
OUTPUT_SIZE = 512
PADDING = 6          # px of margin to leave around the found circle
BG_THRESHOLD = 8     # max(R,G,B) <= this → treated as black background

def find_content_bbox(img: Image.Image):
    """Return (x0, y0, x1, y1) bounding box of non-background content.
    Background is near-black (0,0,0) — the transparent area rendered as black."""
    def is_bg(r, g, b):
        return max(r, g, b) <= BG_THRESHOLD

    w, h = img.size
    pixels = img.load()

    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b = pixels[x, y]
            if not is_bg(r, g, b):
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1

def process(path: str):
    img = Image.open(path).convert('RGB')

    x0, y0, x1, y1 = find_content_bbox(img)

    # expand by padding, clamp to image bounds
    w, h = img.size
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

    # if clamped at left/top, shift right/down
    if sx1 > w:
        sx0 -= sx1 - w
        sx1 = w
    if sy1 > h:
        sy0 -= sy1 - h
        sy1 = h

    cropped = img.crop((sx0, sy0, sx1, sy1))
    resized = cropped.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)

    resized.save(path, 'WEBP', quality=92)
    print(f'  {os.path.basename(path):30s}  bbox=({x0},{y0},{x1},{y1})  crop=({sx0},{sy0},{sx1},{sy1})')

def main():
    files = sorted(f for f in os.listdir(AVATAR_DIR) if f.lower().endswith('.webp'))
    print(f'Processing {len(files)} files in {AVATAR_DIR}\n')
    for f in files:
        process(os.path.join(AVATAR_DIR, f))
    print('\nDone.')

if __name__ == '__main__':
    main()
