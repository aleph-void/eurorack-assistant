// Reading a panel photograph's pixels, and cutting a box out of one.
//
// The floor the rest of services/panelPixels.js stands on: sharp is a native
// module, so it is loaded on first use rather than imported — a panel that is
// merely unrefined beats a server that will not boot — and every function
// here returns null rather than throwing when it cannot be loaded or the
// image cannot be decoded.

import { clamp01 } from './panelGeometry.js';

// Loaded on first use rather than imported: sharp is a native module, and a
// panel that is merely unrefined beats a server that will not boot.
let sharpModule;
export async function loadSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

// Greyscale is all any of this needs: a jack hole against its nut and a knob
// cap against the plate are both contrast, never colour. Alpha is flattened
// onto white first so a PNG with a transparent surround trims like a
// photograph with a white one.
export async function readPixels(file) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(file)
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) return null;
    return { width: info.width, height: info.height, gray: data };
  } catch {
    return null;
  }
}

// Cutting the front plate out of the FILE, rather than merely recording where
// it sits. `box` is the crop in fractions of the whole image; the result is
// the bytes of that box alone, ready to be stored as a panel image in its own
// right. A vector or animated source cannot be cut and handed back in its own
// format, so it lands as PNG — and an install without sharp gets null and
// keeps the crop-as-metadata behaviour.
const CROP_ENCODERS = {
  png: (image) => image.png(),
  jpg: (image) => image.jpeg(),
  webp: (image) => image.webp(),
  gif: (image) => image.gif(),
};

export async function cropImage(file, box, { ext = 'png' } = {}) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) return null;
    const left = Math.min(meta.width - 1, Math.max(0, Math.round(clamp01(box.x) * meta.width)));
    const top = Math.min(meta.height - 1, Math.max(0, Math.round(clamp01(box.y) * meta.height)));
    const width = Math.min(meta.width - left, Math.max(1, Math.round(clamp01(box.w) * meta.width)));
    const height = Math.min(meta.height - top, Math.max(1, Math.round(clamp01(box.h) * meta.height)));
    const extract = () => sharp(file).extract({ left, top, width, height });
    const encoder = CROP_ENCODERS[ext];
    if (encoder) {
      try {
        return { buffer: await encoder(extract()).toBuffer(), width, height, ext };
      } catch {
        // The format cannot be written back (an animated source, a build of
        // libvips without that saver): PNG always can.
      }
    }
    return { buffer: await extract().png().toBuffer(), width, height, ext: 'png' };
  } catch {
    return null;
  }
}
