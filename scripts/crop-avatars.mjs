// crop-avatars.mjs
// Auto-crops each avatar WebP to its non-transparent content bounding box,
// makes it square with 8% padding, then resizes to 256×256 and re-saves.

import sharp from 'sharp';
import { readdir } from 'fs/promises';
import { join } from 'path';

const AVATAR_DIR = 'Images/user-avatars';
const OUTPUT_SIZE = 256;
const ALPHA_THRESHOLD = 15;   // pixels with alpha <= this are "transparent"
const PADDING_FACTOR = 0.08;  // 8% padding around the tight crop

async function cropAvatar(filename) {
    const filepath = join(AVATAR_DIR, filename);

    const { data, info } = await sharp(filepath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;

    let top = height, bottom = -1, left = width, right = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * channels + 3];
            if (alpha > ALPHA_THRESHOLD) {
                if (y < top)    top    = y;
                if (y > bottom) bottom = y;
                if (x < left)   left   = x;
                if (x > right)  right  = x;
            }
        }
    }

    if (bottom < 0) {
        console.warn(`  SKIP ${filename} — fully transparent`);
        return;
    }

    const contentW = right  - left   + 1;
    const contentH = bottom - top    + 1;
    const maxDim   = Math.max(contentW, contentH);
    const pad      = Math.round(maxDim * PADDING_FACTOR);

    // Center the tight crop and expand to square
    const cx = (left + right)  / 2;
    const cy = (top  + bottom) / 2;
    const half = Math.round(maxDim / 2) + pad;

    const cropLeft   = Math.max(0,         Math.round(cx - half));
    const cropTop    = Math.max(0,         Math.round(cy - half));
    const cropRight  = Math.min(width  - 1, Math.round(cx + half));
    const cropBottom = Math.min(height - 1, Math.round(cy + half));
    const cropW = cropRight  - cropLeft  + 1;
    const cropH = cropBottom - cropTop   + 1;

    await sharp(filepath)
        .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 92 })
        .toFile(filepath + '.tmp');

    // Replace original with temp file
    const { rename } = await import('fs/promises');
    await rename(filepath + '.tmp', filepath);

    console.log(`  OK  ${filename}  content=${contentW}x${contentH}  crop=${cropW}x${cropH}`);
}

const files = (await readdir(AVATAR_DIR)).filter(f => f.endsWith('.webp'));
console.log(`Processing ${files.length} avatars in ${AVATAR_DIR}…`);
for (const f of files) {
    await cropAvatar(f);
}
console.log('Done.');
