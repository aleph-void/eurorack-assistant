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
//   2. Every round component is then snapped to the most convincing circular
//      feature near where the model put it — a jack is a dark hole ringed by a
//      bright nut, a knob a dark cap on a bright plate, and both are far more
//      findable than they are describable. "Near" is generous, because a model
//      that has lost its place rather than merely drifted can be a whole
//      component out; what keeps a generous search honest is that travel costs
//      a candidate score, and that no two markers may claim the same hole.
//   3. Whatever the snapped markers moved by is carried into the ones that
//      could not be snapped (LEDs, toggles, anything flat), interpolated from
//      the hardware directly above and below each of them, so a bias that
//      grows down the panel is followed rather than averaged away.
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
// around it ~1.5mm, so nearly every marker moves less than 4mm — but the ones
// worth fixing are the ones that do not. A model that has lost count of the
// controls rather than drifted off one puts a marker a whole component away,
// which is 10mm on a dense panel and further on a loose one, and no window
// tight enough to exclude the neighbour is wide enough to reach it.
//
// So the search reaches past the neighbour on purpose, and the neighbour is
// kept off by evidence rather than by geometry: a candidate pays DRAG_PENALTY
// for every millimetre it asks the marker to travel, and two markers may not
// claim the same piece of hardware (snapPlacements). A marker that is merely a
// little low stays on the control under it because that control is nearer; one
// that is a component out still moves, because at that distance the hardware is
// the only thing left scoring at all.
export const SEARCH_MM = 10;

// What a millimetre of travel costs a candidate, in the grey levels the score
// below is measured in. Set so that a piece of hardware at the far end of the
// search still beats a smudge of silkscreen right under the marker, and so
// that two equally convincing jacks are decided by which one is nearer.
export const DRAG_PENALTY = 5;

// How far below the best of its kind on this panel a candidate may score and
// still be believed to be hardware. See the second pass in snapPlacements.
export const CONFIDENT_SHARE = 0.35;

// The strip along the top and bottom of a plate where the mounting slots go,
// and where no control can be: the rails are there, and a 3.5mm jack's nut is
// 8mm across, so its centre cannot come within 4mm of the edge even if the
// rail were not. Those slots are the one thing on a panel that reads as a
// piece of hardware because it genuinely is one — a dark hole in bright metal,
// scoring 85 on the 2hp 3:1 where the OUT jack 9mm away scores 110 — and being
// nearer to a marker the model dropped low, they win on the arithmetic. They
// are excluded on the geometry instead, which costs nothing real.
export const RAIL_MM = 4;

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

// How much an uneven MIDDLE counts against one, which is the difference
// between a piece of hardware and a piece of printing. A jack's hole is one
// black thing, a knob's cap one dark thing; lettering and logos are ink and
// bare plate alternating, and a disc laid over them averages out to something
// darker than the plate while being nothing of the sort. Measured on the 2hp
// 3:1 panel this was written for, that one term separates the two completely:
// every jack scores 106 or better and the knob 87, while the "OUT" silkscreen
// and the "2hp" logo — the one the OUT marker was actually sitting on — land
// under the floor below rather than merely behind it. It is weighted harder
// than the surround because it is the more telling of the two: hardware is
// allowed an uneven surround (a nut catches the light unevenly) but never an
// uneven middle.
//
// What it does NOT rule out is the mounting slots, which are uniformly dark
// because they are real holes. Those are RAIL_MM's business.
const INNER_UNEVENNESS_WEIGHT = 1;
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
  let innerSquares = 0;
  let innerCount = 0;
  const addInner = (value) => {
    innerSum += value;
    innerSquares += value * value;
    innerCount += 1;
  };
  const centre = at(cx, cy);
  if (centre === null) return null;
  addInner(centre);
  for (const ring of INNER_RINGS) {
    for (let i = 0; i < RING_SAMPLES; i++) {
      const value = at(cx + COS[i] * r * ring, cy + SIN[i] * r * ring);
      if (value === null) continue;
      addInner(value);
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
  const innerUnevenness = Math.sqrt(Math.max(0, innerSquares / innerCount - inner * inner));
  const means = [];
  for (let s = 0; s < SECTORS; s++) {
    if (sectorCount[s] > 0) means.push(sectorSum[s] / sectorCount[s]);
  }
  let unevenness = 0;
  if (means.length >= 3) {
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    unevenness = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / means.length);
  }
  return (
    Math.abs(outer - inner) -
    UNEVENNESS_WEIGHT * unevenness -
    INNER_UNEVENNESS_WEIGHT * innerUnevenness
  );
}

// Two candidates whose scores differ by less than this are the same
// candidate: the middle of a jack's hole is a plateau a few pixels across,
// every point of which describes the hole equally well.
const SCORE_EPSILON = 0.5;

// The middle of the best-scoring positions in a sweep. The peak is a plateau
// rather than a point — a jack's hole describes itself equally well from
// anywhere in the middle few pixels of it — so the answer is the middle of
// every position that scores within a hair of the best, not whichever of them
// the sweep reached first. Taking the first would put the marker on a corner
// of the plateau, which is a bias invented by the search itself, and inventing
// biases is the opposite of the job here.
function sweep(px, bounds, originX, originY, radius, step, r) {
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
}

// Every distinct disc of radius r within `search` pixels of (cx, cy), best
// first. Searched coarsely and then refined around each peak the coarse pass
// found, which is a fraction of the work of a full sweep and lands in the same
// places: the features are smooth discs tens of pixels across, not something
// that hides between samples.
//
// A shortlist rather than a single answer, because over a search this wide the
// winner is no longer obvious from the pixels alone — how far the marker has
// to travel to reach a candidate, and whether another marker has a better
// claim on it, both belong to the caller.
export function discCandidates(px, bounds, cx, cy, r, search, { minContrast = MIN_CONTRAST } = {}) {
  // Fine enough that a disc 2r across cannot fall between grid points, and no
  // finer: every extra sample here is paid for on every candidate.
  const step = Math.max(1, Math.min(Math.round(search / 12), Math.round(r / 3)));
  const size = Math.floor(search / step) * 2 + 1;
  const grid = new Float64Array(size * size).fill(-Infinity);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const x = cx + (ix - (size >> 1)) * step;
      const y = cy + (iy - (size >> 1)) * step;
      if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue;
      const score = discScore(px, bounds, x, y, r);
      if (score !== null) grid[iy * size + ix] = score;
    }
  }

  // The peaks of that grid: a sample no neighbour beats. One per feature,
  // which is what keeps the shortlist a list of hardware rather than a list of
  // positions on the same hole.
  const peaks = [];
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const score = grid[iy * size + ix];
      if (!(score > minContrast)) continue;
      let highest = true;
      for (let ny = Math.max(0, iy - 1); ny <= Math.min(size - 1, iy + 1) && highest; ny++) {
        for (let nx = Math.max(0, ix - 1); nx <= Math.min(size - 1, ix + 1); nx++) {
          if ((nx !== ix || ny !== iy) && grid[ny * size + nx] > score) highest = false;
        }
      }
      if (highest) peaks.push({ x: cx + (ix - (size >> 1)) * step, y: cy + (iy - (size >> 1)) * step });
    }
  }

  const candidates = [];
  for (const peak of peaks) {
    const refined = sweep(px, bounds, peak.x, peak.y, step, 1, r);
    if (!refined || refined.score < minContrast) continue;
    // Several peaks over one hole are one candidate, not several. Two centres
    // closer together than the ring the score reads its surround from are
    // looking at the same piece of hardware — including the ghosts that sit
    // half on a jack and half off it, which score well enough to be mistaken
    // for something of their own. Nothing on a panel puts two round components
    // that close, so nothing real is lost by refusing to believe in them.
    //
    // A better reading of the hole replaces the one held; an equally good one
    // is averaged into it, for the same reason the sweep above averages its
    // own plateau — a hole that describes itself equally well from either side
    // of its middle must not be answered with whichever side was scanned first.
    const same = candidates.find(
      (c) => Math.hypot(c.x - refined.x, c.y - refined.y) < r * OUTER_RING
    );
    if (!same) {
      candidates.push({ ...refined, n: 1 });
    } else if (refined.score > same.score + SCORE_EPSILON) {
      Object.assign(same, refined, { n: 1 });
    } else if (refined.score > same.score - SCORE_EPSILON) {
      same.x = (same.x * same.n + refined.x) / (same.n + 1);
      same.y = (same.y * same.n + refined.y) / (same.n + 1);
      same.score = Math.max(same.score, refined.score);
      same.n += 1;
    }
  }
  return candidates
    .map(({ x, y, score }) => ({ x, y, score }))
    .sort((a, b) => b.score - a.score);
}

// The single most convincing disc within `search` pixels of (cx, cy), counting
// distance from (cx, cy) against a candidate at `dragPerPx` per pixel of it.
// Returns null when nothing within reach reads as hardware at all.
export function findDisc(px, bounds, cx, cy, r, search, { minContrast = MIN_CONTRAST, dragPerPx = 0 } = {}) {
  const candidates = discCandidates(px, bounds, cx, cy, r, search, { minContrast });
  let best = null;
  for (const candidate of candidates) {
    const value = candidate.score - dragPerPx * Math.hypot(candidate.x - cx, candidate.y - cy);
    if (!best || value > best.value) best = { ...candidate, value };
  }
  return best;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Snap every round component onto the hardware it names, then carry the rest
// along with whatever moved either side of them.
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
  const dragPerPx = DRAG_PENALTY / pxPerMm;
  // A knob on a 2HP panel is nearly as wide as the plate; the disc has to stay
  // narrow enough that its surround is still something rather than nothing.
  const maxRadiusMm = (plateWidth / pxPerMm) * 0.35;

  // The mounting strip at either end of the plate, which nothing can be
  // snapped into. Measured from the bounds rather than the crop so it is the
  // same plate the sampling uses.
  const rail = RAIL_MM * pxPerMm;
  const onPlate = (candidate) => candidate.y >= bounds.y0 + rail && candidate.y <= bounds.y1 - rail;

  // What each marker could be naming, and what each candidate is worth to it
  // once the walk there is paid for.
  const shortlists = placements.map((placement) => {
    const radiusMm = SNAP_RADIUS_MM[placement.shape];
    if (!radiusMm) return null;
    const r = Math.max(2, Math.round(Math.min(radiusMm, maxRadiusMm) * pxPerMm));
    const cx = placement.x * px.width;
    const cy = placement.y * px.height;
    return discCandidates(px, bounds, Math.round(cx), Math.round(cy), r, search, { minContrast })
      .filter(onPlate)
      .map((candidate) => ({
        ...candidate,
        r,
        value: candidate.score - dragPerPx * Math.hypot(candidate.x - cx, candidate.y - cy),
      }));
  });

  // Best claim first, and one claimant per piece of hardware. A panel has one
  // marker per hole, so two markers reaching for the same hole means at least
  // one of them is wrong — and rather than plant both on it, the weaker claim
  // is made to look again at whatever is left.
  const assign = (floorFor) => {
    const claims = [];
    for (const [index, shortlist] of shortlists.entries()) {
      for (const candidate of shortlist ?? []) {
        if (candidate.score >= floorFor(placements[index].shape)) claims.push({ index, candidate });
      }
    }
    claims.sort((a, b) => b.candidate.value - a.candidate.value);
    const taken = new Array(placements.length).fill(null);
    const held = [];
    for (const { index, candidate } of claims) {
      if (taken[index]) continue;
      const clash = held.some(
        (h) => Math.hypot(h.x - candidate.x, h.y - candidate.y) < Math.max(h.r, candidate.r)
      );
      if (clash) continue;
      taken[index] = candidate;
      held.push(candidate);
    }
    return taken;
  };

  // A first pass with nothing to go on but the floor below which a candidate
  // is not hardware at all. What that floor cannot know is how convincing this
  // particular photograph's hardware looks: a jack on a lit press shot scores
  // three figures, and next to one of those a score of thirty is not a dim
  // jack but a smear of something else — the corner of a label, the edge of a
  // nut — which is exactly what a marker settles for once the hole it wanted
  // has gone to a better claim.
  //
  // So the panel is asked what its own jacks and its own knobs look like, and
  // the pass is run again with each shape held to a share of the best of its
  // kind found here. Nothing is lost when a shape appears once: the only
  // example of it sets its own bar and clears it.
  const first = assign(() => minContrast);
  const bestByShape = new Map();
  for (const [index, candidate] of first.entries()) {
    if (!candidate) continue;
    const shape = placements[index].shape;
    bestByShape.set(shape, Math.max(bestByShape.get(shape) ?? 0, candidate.score));
  }
  const taken = assign((shape) =>
    Math.max(minContrast, (bestByShape.get(shape) ?? 0) * CONFIDENT_SHARE)
  );

  const results = placements.map((placement, index) => {
    const found = taken[index];
    if (!found) return { placement, moved: null };
    return {
      placement,
      moved: {
        x: (found.x - placement.x * px.width) / px.width,
        y: (found.y - placement.y * px.height) / px.height,
      },
    };
  });

  const moves = results.filter((r) => r.moved).map((r) => r.moved);
  // Three is the fewest that can outvote one bad snap; below that what the
  // snapped markers did is not evidence of anything for the ones that did not.
  const anchors =
    moves.length >= 3
      ? results.filter((r) => r.moved).sort((a, b) => a.placement.y - b.placement.y)
      : [];
  // What the panel as a whole did, which is both what the log reports and the
  // sideways correction every unsnapped marker gets. Sideways is taken as one
  // number rather than interpolated: the bias this file exists to undo is a
  // vertical one — a marker dragged down onto the name printed under its
  // control — and a panel wider than one column puts a marker's nearest
  // neighbours up and down the plate a long way to its left or right, whose
  // sideways travel says nothing about its own.
  const shift =
    moves.length >= 3
      ? { x: median(moves.map((m) => m.x)), y: median(moves.map((m) => m.y)) }
      : { x: 0, y: 0 };

  // How far down a marker that could not be snapped should move: whatever the
  // hardware directly above and below it moved by, in proportion to how far
  // between them it sits. An LED between two jacks that both stayed put stays
  // put; one between a jack that stayed put and a jack that came up 7mm comes
  // up the share of 7mm its position asks for. A single median over the whole
  // panel would give it the same answer as everything else, which is right
  // only when the model's error is a constant — and the error that most needs
  // undoing is the one that grows as the model works its way down the panel.
  const correctionAt = (y) => {
    if (anchors.length === 0) return { x: 0, y: 0 };
    let above = null;
    let below = null;
    for (const anchor of anchors) {
      if (anchor.placement.y <= y) above = anchor;
      else if (!below) below = anchor;
    }
    const span = above && below ? below.placement.y - above.placement.y : 0;
    const t = span > 0 ? (y - above.placement.y) / span : 0;
    const dy = !above
      ? below.moved.y
      : !below
        ? above.moved.y
        : above.moved.y + (below.moved.y - above.moved.y) * t;
    return { x: shift.x, y: dy };
  };

  let shifted = 0;
  const out = results.map(({ placement, moved }) => {
    const delta = moved ?? correctionAt(placement.y);
    if (!delta.x && !delta.y) return placement;
    if (!moved) shifted += 1;
    return {
      ...placement,
      x: clamp01(placement.x + delta.x),
      y: clamp01(placement.y + delta.y),
    };
  });

  return { placements: out, snapped: moves.length, shifted, shift };
}
