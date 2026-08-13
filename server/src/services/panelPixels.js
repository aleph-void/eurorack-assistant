// The pixels of a panel photograph: where the front plate actually is in the
// frame, and where each round piece of hardware actually sits on it.
//
// Component positions come from an LLM looking at the picture
// (services/panelImage.js). A model reading a photograph is reliable about
// WHICH control it is looking at and only approximately right about WHERE it
// is. Measured against the first panels captured here, every one of 23
// markers across three modules landed low by 0.016 ± 0.007 of the image's
// height — about 2% of the panel, half an HP — pulled towards the silkscreened
// name printed under the control it belongs to.
//
// A bias that consistent, on an image we hold the bytes of, is one we can
// measure away rather than argue with. So the model's answer is treated as a
// prior and not as an answer:
//
//   1. The front plate is found by trimming the photograph's background,
//      which needs no model at all: these are product shots of one module on
//      a flat backdrop, and the plate is simply everything that is not the
//      backdrop. That crop is both what the client displays and what gets
//      handed to the model, so it is estimating positions on a picture the
//      panel fills rather than on one it is 4% of.
//   2. Every round component is then snapped to the strongest circular
//      feature within a few millimetres of where the model put it — a jack is
//      a dark hole ringed by a bright nut, a knob a dark cap on a bright
//      plate, and both are far more findable than they are describable.
//   3. Whatever the snapped markers moved by as a group is applied to the
//      ones that could not be snapped (LEDs, toggles, anything flat), so a
//      panel-wide bias is removed from the components too small to measure.
//
// Every step here is optional: if sharp cannot be loaded or the image cannot
// be decoded, each function returns null and the caller keeps what the model
// said, which is what this service did before it existed.

import fs from 'node:fs';
import { HP_MM, PANEL_MM_HEIGHT } from './panelGeometry.js';

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

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// ---------------------------------------------------------------------------
// Finding the front plate
// ---------------------------------------------------------------------------

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

// The box of everything that is not backdrop, as fractions of the image. A
// row or column has to carry a few content pixels before it counts, so JPEG
// ringing along the backdrop does not widen the box to the whole frame.
export function trimBox(px, { tolerance = TRIM_TOLERANCE } = {}) {
  const { width, height, gray } = px;
  const bg = backgroundLevel(px);
  const rows = new Int32Array(height);
  const cols = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (Math.abs(gray[row + x] - bg) > tolerance) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  const span = (counts, min) => {
    let a = 0;
    while (a < counts.length && counts[a] < min) a += 1;
    let b = counts.length - 1;
    while (b >= a && counts[b] < min) b -= 1;
    return b >= a ? [a, b] : null;
  };
  const ys = span(rows, Math.max(2, Math.round(width * 0.002)));
  const xs = span(cols, Math.max(2, Math.round(height * 0.002)));
  if (!ys || !xs) return null;
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

// ---------------------------------------------------------------------------
// Snapping a marker onto the hardware it names
// ---------------------------------------------------------------------------

// The radius, in millimetres, of the dark middle each shape presents: a 3.5mm
// jack's hole inside its nut, a knob's cap. Anything not listed here is flat
// silkscreen or an LED and is moved with the group instead.
export const SNAP_RADIUS_MM = { jack: 2.2, knob: 4.5, other: 2.5 };

// How far a marker may be moved. The measured bias is ~2.7mm and the scatter
// around it ~1.5mm, so this covers both without reaching the control above or
// below (which are 9mm apart at the tightest).
export const SEARCH_MM = 3.5;

// Ring geometry, as multiples of the component's radius. The inner rings sit
// inside the dark middle, the outer one lands on the nut or the bare plate.
const RING_SAMPLES = 24;
const INNER_RINGS = [0.4, 0.7];
const OUTER_RING = 1.35;
const SECTORS = 8;
const COS = [];
const SIN = [];
for (let i = 0; i < RING_SAMPLES; i++) {
  COS.push(Math.cos((i * 2 * Math.PI) / RING_SAMPLES));
  SIN.push(Math.sin((i * 2 * Math.PI) / RING_SAMPLES));
}

// Contrast, in grey levels, below which a candidate is not a piece of
// hardware — a flat patch of plate scores near zero, a jack hole scores well
// over a hundred.
export const MIN_CONTRAST = 18;
// How much an uneven surround counts against a candidate. Hardware sits in a
// ring of one thing; a letter of the silkscreen sits in a ring of plate on
// three sides and more letters on the fourth.
const UNEVENNESS_WEIGHT = 0.6;
const MIN_RING_SAMPLES = 8;

// How well a disc of radius r centred on (cx, cy) reads as a round component.
// Samples outside `bounds` (the plate itself) are dropped rather than counted
// as background: on a 2HP module a knob is nearly as wide as the panel, so
// the only part of its surround that is on the plate at all is the arc above
// it and the arc below it. Returns null when too little of the ring lands on
// the plate to judge.
export function discScore({ width, height, gray }, bounds, cx, cy, r) {
  const at = (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < bounds.x0 || px > bounds.x1 || py < bounds.y0 || py > bounds.y1) return null;
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    return gray[py * width + px];
  };

  let innerSum = 0;
  let innerCount = 0;
  const centre = at(cx, cy);
  if (centre === null) return null;
  innerSum += centre;
  innerCount += 1;
  for (const ring of INNER_RINGS) {
    for (let i = 0; i < RING_SAMPLES; i++) {
      const value = at(cx + COS[i] * r * ring, cy + SIN[i] * r * ring);
      if (value === null) continue;
      innerSum += value;
      innerCount += 1;
    }
  }
  if (innerCount < MIN_RING_SAMPLES) return null;

  const sectorSum = new Float64Array(SECTORS);
  const sectorCount = new Int32Array(SECTORS);
  let outerSum = 0;
  let outerCount = 0;
  for (let i = 0; i < RING_SAMPLES; i++) {
    const value = at(cx + COS[i] * r * OUTER_RING, cy + SIN[i] * r * OUTER_RING);
    if (value === null) continue;
    const sector = Math.floor((i * SECTORS) / RING_SAMPLES);
    sectorSum[sector] += value;
    sectorCount[sector] += 1;
    outerSum += value;
    outerCount += 1;
  }
  if (outerCount < MIN_RING_SAMPLES) return null;

  const inner = innerSum / innerCount;
  const outer = outerSum / outerCount;
  const means = [];
  for (let s = 0; s < SECTORS; s++) {
    if (sectorCount[s] > 0) means.push(sectorSum[s] / sectorCount[s]);
  }
  let unevenness = 0;
  if (means.length >= 3) {
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    unevenness = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / means.length);
  }
  return Math.abs(outer - inner) - UNEVENNESS_WEIGHT * unevenness;
}

// Two candidates whose scores differ by less than this are the same
// candidate: the middle of a jack's hole is a plateau a few pixels across,
// every point of which describes the hole equally well.
const SCORE_EPSILON = 0.5;

// The best-scoring disc within `search` pixels of (cx, cy). Searched coarsely
// and then refined around what the coarse pass found, which is a hundredth of
// the work of a full sweep and lands on the same peak: the features are
// smooth discs tens of pixels across, not something that hides between
// samples.
//
// The peak is a plateau rather than a point — a jack's hole describes itself
// equally well from anywhere in the middle few pixels of it — so the answer is
// the middle of every position that scores within a hair of the best, not
// whichever of them the sweep reached first. Taking the first would put the
// marker on a corner of the plateau, which is a bias invented by the search
// itself, and inventing biases is the opposite of the job here.
export function findDisc(px, bounds, cx, cy, r, search) {
  const sweep = (originX, originY, radius, step) => {
    const found = [];
    let best = -Infinity;
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const x = originX + dx;
        const y = originY + dy;
        if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue;
        const score = discScore(px, bounds, x, y, r);
        if (score === null) continue;
        found.push({ x, y, score });
        if (score > best) best = score;
      }
    }
    const top = found.filter((c) => c.score > best - SCORE_EPSILON);
    if (top.length === 0) return null;
    return {
      x: top.reduce((sum, c) => sum + c.x, 0) / top.length,
      y: top.reduce((sum, c) => sum + c.y, 0) / top.length,
      score: best,
    };
  };
  const coarse = Math.max(1, Math.round(search / 12));
  const rough = sweep(cx, cy, search, coarse);
  if (!rough) return null;
  return sweep(Math.round(rough.x), Math.round(rough.y), coarse, 1) ?? rough;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Snap every round component onto the hardware it names, then move the rest
// by however far the group moved.
//
// `crop` is the front plate's box within the image, which sets both the
// millimetre scale (a plate is 128.5mm tall, whatever the photograph's
// resolution) and the bounds a marker may not be pushed outside of.
//
// Returns the placements with x/y replaced, plus a count of what moved how,
// for the job log.
export function snapPlacements(px, placements, crop, { minContrast = MIN_CONTRAST } = {}) {
  const plateHeight = crop.h * px.height;
  const plateWidth = crop.w * px.width;
  if (!(plateHeight > 0) || !(plateWidth > 0)) {
    return { placements, snapped: 0, shifted: 0, shift: { x: 0, y: 0 } };
  }
  const pxPerMm = plateHeight / PANEL_MM_HEIGHT;
  const bounds = {
    x0: Math.round(crop.x * px.width),
    y0: Math.round(crop.y * px.height),
    x1: Math.round((crop.x + crop.w) * px.width) - 1,
    y1: Math.round((crop.y + crop.h) * px.height) - 1,
  };
  const search = Math.max(2, Math.round(SEARCH_MM * pxPerMm));
  // A knob on a 2HP panel is nearly as wide as the plate; the disc has to stay
  // narrow enough that its surround is still something rather than nothing.
  const maxRadiusMm = (plateWidth / pxPerMm) * 0.35;

  const results = placements.map((placement) => {
    const radiusMm = SNAP_RADIUS_MM[placement.shape];
    if (!radiusMm) return { placement, moved: null };
    const r = Math.max(2, Math.round(Math.min(radiusMm, maxRadiusMm) * pxPerMm));
    const cx = placement.x * px.width;
    const cy = placement.y * px.height;
    const found = findDisc(px, bounds, Math.round(cx), Math.round(cy), r, search);
    if (!found || found.score < minContrast) return { placement, moved: null };
    return {
      placement,
      moved: { x: (found.x - cx) / px.width, y: (found.y - cy) / px.height },
    };
  });

  const moves = results.filter((r) => r.moved).map((r) => r.moved);
  // Three is the fewest that can outvote one bad snap; below that a shared
  // shift is not evidence of anything.
  const shift =
    moves.length >= 3
      ? { x: median(moves.map((m) => m.x)), y: median(moves.map((m) => m.y)) }
      : { x: 0, y: 0 };

  let shifted = 0;
  const out = results.map(({ placement, moved }) => {
    if (!moved && (shift.x === 0 && shift.y === 0)) return placement;
    if (!moved) shifted += 1;
    const delta = moved ?? shift;
    return {
      ...placement,
      x: clamp01(placement.x + delta.x),
      y: clamp01(placement.y + delta.y),
    };
  });

  return { placements: out, snapped: moves.length, shifted, shift };
}
