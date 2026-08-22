// Finding the front plate in the frame — where the module is in the photograph.
//
// These are product shots of one module on a flat backdrop, so the plate is
// simply everything that is not the backdrop — which needs no model at all.
// The crop this measures is both what the client displays and what gets
// handed to the model, so it estimates positions on a picture the panel
// fills rather than on one it is 4% of.

import fs from 'node:fs';
import { clamp01, HP_MM, PANEL_MM_HEIGHT, hpFromAspect } from './panelGeometry.js';
import { loadSharp } from './panelBitmap.js';

// How far from the backdrop's own level a pixel has to be to count as the
// module rather than the background it was shot against.
export const TRIM_TOLERANCE = 20;

// The backdrop's grey level, read as the median of the frame's outermost ring
// of pixels — the one part of a product shot that is always background.
export function backgroundLevel({ width, height, gray }) {
  const samples = [];
  for (let x = 0; x < width; x++) {
    samples.push(gray[x], gray[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y++) {
    samples.push(gray[y * width], gray[y * width + width - 1]);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

// The box of everything that is not backdrop, as fractions of the image.
//
// A line (row or column) is backdrop when it is LOCALLY UNIFORM — every
// pixel sits within tolerance of its own ~TRIM_BLOCK-pixel stretch's median —
// AND ONE LEVEL ALONG ITS LENGTH, stretch to stretch — AND CONTINUOUS with
// the line peeled just before it, block for block. Three tests because
// backdrop has to beat three impostors, and each test catches what the
// others cannot:
//
//   - One global background level failed on gradients: real product shots
//     put the module on falloff lighting, and measured against the
//     frame-wide median a darker band across the bottom of the photograph
//     read as content (so the bottom edge never trimmed) and donated its
//     pixels to every column crossing it (so the sides never trimmed
//     either) — only the clean top edge ever moved. Locally, a gradient
//     drifts a level or two per line and is as uniform as any backdrop;
//     that is what the uniformity test accepts.
//   - Uniformity alone then over-trims from the other side: a featureless
//     stretch of plate is exactly as uniform as backdrop. What it cannot be
//     is continuous — stepping from backdrop onto the plate jumps the level
//     in one line, where a gradient never does. That is what the
//     continuity test stops at.
//   - A line that runs ACROSS the plate is uniform inside each of its
//     stretches too, and steps between them where it meets the plate's edge.
//     A photograph padded down the sides only is nothing but such rows, and
//     without this test they read as backdrop the moment the columns have
//     been peeled in to the plate.
//
// A line still has to carry a few contrasting pixels before it counts as
// content, so JPEG ringing along the backdrop does not widen the box to the
// whole frame. The peel works from the outside in and stops at the first
// content line, which is what lets a blank stretch of plate in the middle
// stay inside the box: it is never reached.
const TRIM_BLOCK = 32;

export function trimBox(px, { tolerance = TRIM_TOLERANCE } = {}) {
  const { width, height, gray } = px;

  // One line's per-stretch medians, and its contrasting pixel count —
  // pixels that deviate from their own stretch's median by more than the
  // tolerance. Stretch boundaries depend only on [from, to), so adjacent
  // lines' medians line up block for block for the continuity test.
  const block = new Uint8Array(TRIM_BLOCK);
  const lineStats = (line, isRow, from, to) => {
    const stride = isRow ? 1 : width;
    const base = isRow ? line * width : line;
    const medians = [];
    let content = 0;
    for (let start = from; start < to; start += TRIM_BLOCK) {
      const size = Math.min(TRIM_BLOCK, to - start);
      for (let i = 0; i < size; i++) block[i] = gray[base + (start + i) * stride];
      const median = block.slice(0, size).sort()[size >> 1];
      medians.push(median);
      for (let i = 0; i < size; i++) {
        if (Math.abs(block[i] - median) > tolerance) content += 1;
      }
    }
    return { medians, content };
  };

  const jumps = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > tolerance) return true;
    }
    return false;
  };

  // Backdrop is also one level ALONG the line: stretch to stretch, its
  // medians step within tolerance. Locally uniform is not enough on its own,
  // because a line that crosses the plate is uniform inside every stretch and
  // still jumps between them. A gradient drifts a level or two per stretch
  // and stays flat by this test.
  const level = (medians) => {
    for (let i = 1; i < medians.length; i++) {
      if (Math.abs(medians[i] - medians[i - 1]) > tolerance) return false;
    }
    return true;
  };

  const contentMin = (extent) => Math.max(2, Math.round(extent * 0.002));

  // May the peel start at this edge of the frame at all?
  //
  // Peeling inwards assumes the edge is backdrop, and the FIRST line peeled
  // is the one line with nothing before it to be continuous with — so it is
  // taken on trust, and whatever it is becomes the level the peel then
  // follows. That is fine at an edge that really is backdrop and wrong at one
  // the module reaches, which is what a photograph padded down the SIDES ONLY
  // is: the plate runs to the top and bottom of the frame, and once the
  // column pass has peeled in to the plate, the next row pass sees nothing
  // but plate, calls the featureless top of it backdrop, and eats down the
  // module until it reaches a knob. Both ends of the module go, and the crop
  // that comes out is the wrong shape (rejected in panelCrop, so the trim
  // reports finding no plate) or wrong (the module beheaded).
  //
  // So the trust is granted once, per edge, against the WHOLE frame, before
  // either axis has been narrowed to something that cannot show the module.
  // Full width, a row through a side-padded photograph plainly crosses the
  // plate, and the top and bottom simply never peel — which is right, there
  // is nothing there to peel.
  const edgeIsBackdrop = (line, isRow) => {
    const extent = isRow ? width : height;
    const stats = lineStats(line, isRow, 0, extent);
    return stats.content < contentMin(extent) && level(stats.medians);
  };

  const span = (length, isRow, from, to, edges) => {
    const min = contentMin(to - from);
    const isBackdrop = (line, prev) => {
      const stats = lineStats(line, isRow, from, to);
      if (stats.content >= min) return null;
      if (!level(stats.medians)) return null;
      if (prev && jumps(prev.medians, stats.medians)) return null;
      return stats;
    };
    let a = 0;
    if (edges[0]) {
      for (let prev = null; a < length; a += 1) {
        const stats = isBackdrop(a, prev);
        if (!stats) break;
        prev = stats;
      }
    }
    let b = length - 1;
    if (edges[1]) {
      for (let prev = null; b >= a; b -= 1) {
        const stats = isBackdrop(b, prev);
        if (!stats) break;
        prev = stats;
      }
    }
    return b >= a ? [a, b] : null;
  };

  const rowEdges = [edgeIsBackdrop(0, true), edgeIsBackdrop(height - 1, true)];
  const colEdges = [edgeIsBackdrop(0, false), edgeIsBackdrop(width - 1, false)];

  // Rows and columns take turns, each measured only inside the other's
  // current span: once the row pass has peeled a full-width band off the
  // bottom, the column pass no longer sees that band's pixels and can peel
  // the sides it was holding open. One extra round each way settles it;
  // the cap is a guard, not a tuning knob.
  let ys = [0, height - 1];
  let xs = [0, width - 1];
  for (let pass = 0; pass < 4; pass++) {
    const nextYs = span(height, true, xs[0], xs[1] + 1, rowEdges);
    if (!nextYs) return null;
    const nextXs = span(width, false, nextYs[0], nextYs[1] + 1, colEdges);
    if (!nextXs) return null;
    const settled =
      nextYs[0] === ys[0] && nextYs[1] === ys[1] && nextXs[0] === xs[0] && nextXs[1] === xs[1];
    ys = nextYs;
    xs = nextXs;
    if (settled) break;
  }
  return {
    x: xs[0] / width,
    y: ys[0] / height,
    w: (xs[1] - xs[0] + 1) / width,
    h: (ys[1] - ys[0] + 1) / height,
  };
}

// A trimmed box smaller than this is a speck, not a module.
const MIN_TRIM = 0.02;
// How far the trimmed box's shape may be from the shape a panel of this many
// HP has to be. A photograph carrying the module's box, a cable or a second
// module trims to something the wrong shape, and a wrong crop is worse than
// none: the whole image still shows the panel, it just shows other things too.
const ASPECT_TOLERANCE = 1.6;

// The front plate's box within the photograph. Returns null when the image
// cannot be trusted to be one module on a flat backdrop.
export function panelCrop(px, { hp = null } = {}) {
  const box = trimBox(px);
  if (!box) return null;
  if (box.w < MIN_TRIM || box.h < MIN_TRIM) return null;
  if (hp) {
    const expected = (hp * HP_MM) / PANEL_MM_HEIGHT;
    const actual = (box.w * px.width) / (box.h * px.height);
    if (actual > expected * ASPECT_TOLERANCE || actual < expected / ASPECT_TOLERANCE) return null;
  }
  return box;
}

// How wide the plate inside `box` is, in HP, measured off the pixels: `box`
// is a fraction of a `px.width` x `px.height` image, and a 3U plate is a
// known number of millimetres tall, so the box's shape in real pixels is the
// only thing needed. Null when the box has no shape to measure.
//
// This is what lets a supplied picture correct the module's recorded width:
// the rack organizer draws every panel into an HP-wide slot, so a photograph
// that takes in more of the rack than the recorded width allows for — a
// module standing next to its expander — is stretched until it is measured.
export function boxHp(px, box) {
  const width = box.w * px.width;
  const height = box.h * px.height;
  if (!(width > 0) || !(height > 0)) return null;
  return hpFromAspect(width / height);
}

// Grow a box by a fraction of its own size, clamped to the image.
export function growBox(box, margin) {
  const x = clamp01(box.x - box.w * margin);
  const y = clamp01(box.y - box.h * margin);
  return {
    x,
    y,
    w: Math.min(box.w * (1 + margin * 2), 1 - x),
    h: Math.min(box.h * (1 + margin * 2), 1 - y),
  };
}

// A point given as a fraction of `box` re-expressed as a fraction of the whole
// image the box is a box within.
export const pointInBox = (box, x, y) => ({ x: box.x + x * box.w, y: box.y + y * box.h });

// Write the part of `file` inside `box` out as a PNG, which every backend's
// image reader handles whatever the original was. Scaled so the long side
// lands in a range worth showing a model: a 100px-wide 2HP strip is upscaled,
// a 4000px press shot is brought down. Returns the path, or null.
export async function writeCrop(file, box, outPath, { minLongSide = 900, maxLongSide = 1800 } = {}) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) return null;
    const left = Math.min(meta.width - 1, Math.max(0, Math.round(box.x * meta.width)));
    const top = Math.min(meta.height - 1, Math.max(0, Math.round(box.y * meta.height)));
    const width = Math.max(1, Math.min(meta.width - left, Math.round(box.w * meta.width)));
    const height = Math.max(1, Math.min(meta.height - top, Math.round(box.h * meta.height)));
    let pipeline = sharp(file)
      .flatten({ background: '#ffffff' })
      .extract({ left, top, width, height });
    const long = Math.max(width, height);
    const scale = long < minLongSide ? minLongSide / long : long > maxLongSide ? maxLongSide / long : 1;
    if (scale !== 1) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        kernel: 'lanczos3',
      });
    }
    await pipeline.png().toFile(outPath);
    return fs.existsSync(outPath) ? outPath : null;
  } catch {
    return null;
  }
}
