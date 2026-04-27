"""
crop_avatars.py
Auto-crops each avatar WebP to its non-transparent content bounding box,
pads to a square with 8% margin, and resizes to 256x256.
"""

from PIL import Image
import os, glob

AVATAR_DIR  = r"Images\user-avatars"
OUTPUT_SIZE = 256
ALPHA_THRESHOLD = 15   # alpha <= this is considered transparent
PADDING_FACTOR  = 0.02 # 2% padding around the tight content crop

def crop_avatar(path):
    img = Image.open(path).convert("RGBA")
    data = img.load()
    w, h = img.size

    top, bottom, left, right = h, -1, w, -1
    for y in range(h):
        for x in range(w):
            if data[x, y][3] > ALPHA_THRESHOLD:
                if y < top:    top    = y
                if y > bottom: bottom = y
                if x < left:   left   = x
                if x > right:  right  = x

    if bottom < 0:
        print(f"  SKIP {os.path.basename(path)} — fully transparent")
        return

    content_w = right  - left   + 1
    content_h = bottom - top    + 1
    max_dim   = max(content_w, content_h)
    pad       = int(max_dim * PADDING_FACTOR)

    cx = (left + right)  / 2
    cy = (top  + bottom) / 2
    half = int(max_dim / 2) + pad

    crop_left   = max(0,     int(cx - half))
    crop_top    = max(0,     int(cy - half))
    crop_right  = min(w,     int(cx + half) + 1)
    crop_bottom = min(h,     int(cy + half) + 1)

    cropped = img.crop((crop_left, crop_top, crop_right, crop_bottom))

    # Make it square (letterbox with transparent bg if needed)
    cw, ch = cropped.size
    side = max(cw, ch)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - cw) // 2, (side - ch) // 2))

    result = square.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
    result.save(path, "WEBP", quality=92)
    print(f"  OK  {os.path.basename(path):<40} content={content_w}x{content_h}  crop={crop_right-crop_left}x{crop_bottom-crop_top}")

files = glob.glob(os.path.join(AVATAR_DIR, "*.webp"))
print(f"Processing {len(files)} avatars in '{AVATAR_DIR}' …")
for f in sorted(files):
    crop_avatar(f)
print("Done.")
