// Panel pictures at the size they are actually drawn.
//
// A stored panel is the file the manufacturer published: front-panel
// photographs run to 3-8MB and several thousand pixels across. The patch
// diagram draws each one a few hundred pixels wide, and a patch of a full
// case draws forty of them at once — so the browser downloads and decodes
// tens of megapixels to paint a picture that never needed them. The bytes
// were always cached (they are addressed by their own hash and served
// immutable); what cost the time was how many of them there were.
//
// So a panel is also served at a handful of fixed widths, rendered once on
// demand and kept next to the original under the same content-addressed
// naming. The variants are WEBP whatever the source was: it is the smallest
// format every browser renders, and a resized copy is a derived picture
// rather than the file we were given, which stays untouched.
//
// Every step is optional. An install whose sharp will not load, a vector
// panel (already tiny, and infinitely scalable), an animated GIF (resizing
// would flatten it): the caller serves the original and nothing is lost but
// the saving.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSharp } from './panelPixels.js';

// The widths a panel is served at. Few enough that the cache on disk stays
// small and warm, spaced so the next one up is always a real improvement.
export const PANEL_WIDTHS = [128, 256, 512, 1024];

// Formats worth resizing: a vector scales by itself and a GIF may be moving.
const RESIZABLE = new Set(['png', 'jpg', 'webp']);

export const thumbsDir = (panelsDir) => path.join(panelsDir, 'thumbs');

// The width a request is served at: the smallest offered width that is at
// least as wide as the one asked for, or null when the picture is wanted
// bigger than any variant (then the original is the right answer).
export function bucketWidth(requested) {
  const wanted = Number(requested);
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  return PANEL_WIDTHS.find((width) => width >= wanted) ?? null;
}

// The stored variant of one panel at one width, rendering it if this is the
// first time it has been asked for. Returns the file path, or null when the
// original is what should be served.
export async function panelVariant(panelsDir, hash, ext, width) {
  if (!RESIZABLE.has(ext) || !PANEL_WIDTHS.includes(width)) return null;
  const dir = thumbsDir(panelsDir);
  const file = path.join(dir, `${hash}@${width}.webp`);
  try {
    await fs.access(file);
    return file;
  } catch {
    // Not rendered yet.
  }
  const sharp = await loadSharp();
  if (!sharp) return null;
  const source = path.join(panelsDir, `${hash}.${ext}`);
  // Rendered to a private name and moved into place, so two requests racing
  // for the same variant cannot serve each other a half-written file.
  const partial = `${file}.${crypto.randomUUID()}`;
  try {
    await fs.mkdir(dir, { recursive: true });
    const info = await sharp(source)
      // A panel narrower than the variant is left alone rather than blown up:
      // the point is fewer pixels, never invented ones.
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(partial);
    // Nothing was gained — a small PNG can encode smaller than its WEBP.
    // Serve the original rather than keep a copy that is no better.
    if (!info?.size) throw new Error('no output');
    await fs.rename(partial, file);
    return file;
  } catch {
    await fs.rm(partial, { force: true }).catch(() => {});
    return null;
  }
}
