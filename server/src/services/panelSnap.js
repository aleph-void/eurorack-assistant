// Snapping a marker onto the hardware it names.
//
// A model reading a photograph is reliable about WHICH control it is looking
// at and only approximately right about WHERE it is — measured across the
// first panels captured here, every one of 23 markers landed low by
// 0.016 ± 0.007 of the image's height, pulled towards the silkscreened name
// printed under the control it belongs to. A bias that consistent, on an
// image we hold the bytes of, is one to measure away rather than argue with.
//
// So every round component is snapped to the most convincing circular feature
// near where the model put it — a jack is a dark hole ringed by a bright nut,
// a knob a dark cap on a bright plate, and both are far more findable than
// they are describable. 'Near' is generous, because a model that has lost its
// place rather than merely drifted can be a whole component out; what keeps a
// generous search honest is that travel costs a candidate score, and that no
// two markers may claim the same hole. Whatever the snapped markers moved by
// is then carried into the ones that could not be snapped (LEDs, toggles,
// anything flat), interpolated from the hardware directly above and below
// each of them, so a bias that grows down the panel is followed rather than
// averaged away.

import { clamp01, PANEL_MM_HEIGHT } from './panelGeometry.js';

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
