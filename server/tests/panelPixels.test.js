// Measuring a panel photograph: trimming the backdrop off the front plate,
// and snapping a marker onto the hardware it names.
//
// The fixtures are drawn rather than downloaded — a 2HP plate on a backdrop,
// with jacks and knobs as dark discs and silkscreen names as dark bars a few
// millimetres under each one. That is enough to exercise everything that
// matters here, including the mistake this exists to undo: a marker that has
// drifted off the control and towards its label.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MIN_CONTRAST,
  backgroundLevel,
  findDisc,
  growBox,
  loadSharp,
  panelCrop,
  pointInBox,
  readPixels,
  snapPlacements,
  trimBox,
  writeCrop,
} from '../src/services/panelPixels.js';
import { HP_MM, PANEL_MM_HEIGHT } from '../src/services/panelGeometry.js';

// A drawn 2HP module on a backdrop, at 10 pixels per millimetre — the same
// order of magnitude as the press shots this runs against.
const PX_PER_MM = 10;
const PLATE_W = Math.round(2 * HP_MM * PX_PER_MM); // 102px
const PLATE_H = Math.round(PANEL_MM_HEIGHT * PX_PER_MM); // 1285px
const PAD_X = 400;
const PAD_Y = 120;
const IMAGE_W = PLATE_W + PAD_X * 2;
const IMAGE_H = PLATE_H + PAD_Y * 2;

const BACKDROP = 250;
const PLATE = 200;
const HARDWARE = 20;

// Where each control sits on the drawn plate, in millimetres from its top.
const CONTROLS = [
  { name: 'IN', shape: 'jack', mm: 20 },
  { name: 'FREQ', shape: 'knob', mm: 45 },
  { name: 'CV', shape: 'jack', mm: 70 },
  { name: 'OUT', shape: 'jack', mm: 95 },
];
const RADIUS_MM = { jack: 2.4, knob: 4.5 };
// The silkscreen sits under the control, which is what pulls a model's answer
// down and what the snap has to be able to climb back out of.
const LABEL_OFFSET_MM = 6;

function drawFixture() {
  const gray = Buffer.alloc(IMAGE_W * IMAGE_H, BACKDROP);
  const set = (x, y, value) => {
    if (x < 0 || y < 0 || x >= IMAGE_W || y >= IMAGE_H) return;
    gray[y * IMAGE_W + x] = value;
  };
  for (let y = PAD_Y; y < PAD_Y + PLATE_H; y++) {
    for (let x = PAD_X; x < PAD_X + PLATE_W; x++) set(x, y, PLATE);
  }
  const centreX = PAD_X + PLATE_W / 2;
  for (const control of CONTROLS) {
    const cy = PAD_Y + control.mm * PX_PER_MM;
    const r = RADIUS_MM[control.shape] * PX_PER_MM;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) set(Math.round(centreX + dx), Math.round(cy + dy), HARDWARE);
      }
    }
    // The name: a short bar of lettering, which is dark like the hardware but
    // is not round and does not sit in a ring of plate.
    const labelY = cy + LABEL_OFFSET_MM * PX_PER_MM;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -22; dx <= 22; dx++) {
        if ((dx + 22) % 7 < 4) set(Math.round(centreX + dx), Math.round(labelY + dy), HARDWARE);
      }
    }
  }
  return gray;
}

const FIXTURE = { width: IMAGE_W, height: IMAGE_H, gray: drawFixture() };

// Where a control really is, as a fraction of the whole image.
const truth = (control) => ({
  x: (PAD_X + PLATE_W / 2) / IMAGE_W,
  y: (PAD_Y + control.mm * PX_PER_MM) / IMAGE_H,
});

// The same, dragged down towards the label by the ~2.7mm a model drags it.
const asModelWouldSay = (control, driftMm = 2.7) => ({
  name: control.name,
  shape: control.shape,
  ...truth(control),
  y: (PAD_Y + (control.mm + driftMm) * PX_PER_MM) / IMAGE_H,
});

const mmOff = (placement, control, crop) =>
  Math.abs(placement.y - truth(control).y) * (IMAGE_H / (crop.h * IMAGE_H)) * PANEL_MM_HEIGHT;

describe('finding the front plate in a photograph', () => {
  it('reads the backdrop off the edge of the frame', () => {
    expect(backgroundLevel(FIXTURE)).toBe(BACKDROP);
  });

  it('trims the backdrop away to the plate itself', () => {
    const box = trimBox(FIXTURE);
    expect(box.x * IMAGE_W).toBeCloseTo(PAD_X, 0);
    expect(box.y * IMAGE_H).toBeCloseTo(PAD_Y, 0);
    expect(box.w * IMAGE_W).toBeCloseTo(PLATE_W, 0);
    expect(box.h * IMAGE_H).toBeCloseTo(PLATE_H, 0);
  });

  it('accepts a trimmed box that is the shape a 2HP panel has to be', () => {
    expect(panelCrop(FIXTURE, { hp: 2 })).not.toBeNull();
  });

  it('rejects one that is nothing like the shape of the module it claims to be', () => {
    // Told it is 20HP, the same thin strip cannot be the plate — the picture
    // is of something else as well, and the whole image is the safer crop.
    expect(panelCrop(FIXTURE, { hp: 20 })).toBeNull();
  });

  it('finds nothing to trim in a blank image', () => {
    const blank = { width: 200, height: 200, gray: Buffer.alloc(200 * 200, 128) };
    expect(trimBox(blank)).toBeNull();
    expect(panelCrop(blank)).toBeNull();
  });

  it('grows a box by a fraction of itself without leaving the image', () => {
    const grown = growBox({ x: 0.4, y: 0.1, w: 0.2, h: 0.8 }, 0.1);
    expect(grown.x).toBeCloseTo(0.38, 5);
    expect(grown.w).toBeCloseTo(0.24, 5);
    expect(growBox({ x: 0, y: 0, w: 1, h: 1 }, 0.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('re-expresses a point in a crop as a point in the whole image', () => {
    const point = pointInBox({ x: 0.4, y: 0.1, w: 0.2, h: 0.8 }, 0.5, 0.25);
    expect(point.x).toBeCloseTo(0.5, 6);
    expect(point.y).toBeCloseTo(0.3, 6);
  });
});

describe('snapping a marker onto the hardware it names', () => {
  const crop = panelCrop(FIXTURE, { hp: 2 });

  it('scores the hardware itself above anything else nearby', () => {
    const control = CONTROLS[0];
    const bounds = {
      x0: Math.round(crop.x * IMAGE_W),
      y0: Math.round(crop.y * IMAGE_H),
      x1: Math.round((crop.x + crop.w) * IMAGE_W) - 1,
      y1: Math.round((crop.y + crop.h) * IMAGE_H) - 1,
    };
    const cx = Math.round(truth(control).x * IMAGE_W);
    const cy = Math.round(truth(control).y * IMAGE_H);
    const r = Math.round(RADIUS_MM.jack * PX_PER_MM);
    const found = findDisc(FIXTURE, bounds, cx, cy + 27, r, 35);
    expect(found.score).toBeGreaterThan(MIN_CONTRAST);
    expect(found.y).toBe(cy);
  });

  it('pulls every marker back off the silkscreen and onto its control', () => {
    const placements = CONTROLS.map((c) => asModelWouldSay(c));
    for (const [i, placement] of placements.entries()) {
      expect(mmOff(placement, CONTROLS[i], crop)).toBeGreaterThan(2);
    }
    const snap = snapPlacements(FIXTURE, placements, crop);
    expect(snap.snapped).toBe(CONTROLS.length);
    for (const [i, placement] of snap.placements.entries()) {
      expect(mmOff(placement, CONTROLS[i], crop)).toBeLessThan(0.2);
    }
  });

  it('moves what it could not snap by however far the rest agreed to move', () => {
    const placements = [
      ...CONTROLS.map((c) => asModelWouldSay(c)),
      // An LED: nothing round and dark to find, so it can only be carried
      // along by the panel-wide correction the others measured.
      { name: 'LED', shape: 'display', ...truth(CONTROLS[1]), y: 0.5 },
    ];
    const snap = snapPlacements(FIXTURE, placements, crop);
    expect(snap.snapped).toBe(CONTROLS.length);
    expect(snap.shifted).toBe(1);
    // The others all moved up by the drift, so the LED does too.
    const drift = (2.7 * PX_PER_MM) / IMAGE_H;
    expect(snap.placements.at(-1).y).toBeCloseTo(0.5 - drift, 3);
  });

  it('leaves a marker where it is when there is no hardware under it', () => {
    const flat = { width: 400, height: 1400, gray: Buffer.alloc(400 * 1400, 180) };
    const placements = [{ name: 'IN', shape: 'jack', x: 0.5, y: 0.5 }];
    const snap = snapPlacements(flat, placements, { x: 0, y: 0, w: 1, h: 1 });
    expect(snap.snapped).toBe(0);
    expect(snap.placements[0]).toEqual(placements[0]);
  });

  it('does nothing at all with a crop that has no area', () => {
    const placements = [{ name: 'IN', shape: 'jack', x: 0.5, y: 0.5 }];
    const snap = snapPlacements(FIXTURE, placements, { x: 0, y: 0, w: 0, h: 0 });
    expect(snap.placements).toBe(placements);
  });
});

describe('reading and cropping an image file', () => {
  let dir;
  let file;

  beforeAll(async () => {
    const sharp = await loadSharp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-pixels-'));
    file = path.join(dir, 'panel.png');
    await sharp(FIXTURE.gray, { raw: { width: IMAGE_W, height: IMAGE_H, channels: 1 } })
      .png()
      .toFile(file);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a file back as the greyscale it was drawn as', async () => {
    const px = await readPixels(file);
    expect(px.width).toBe(IMAGE_W);
    expect(px.height).toBe(IMAGE_H);
    expect(panelCrop(px, { hp: 2 }).w * px.width).toBeCloseTo(PLATE_W, 0);
  });

  it('returns nothing for a file that is not an image', async () => {
    const bogus = path.join(dir, 'not-an-image.png');
    fs.writeFileSync(bogus, 'this is not a png');
    expect(await readPixels(bogus)).toBeNull();
  });

  it('writes the plate out on its own, scaled up to something worth looking at', async () => {
    const out = path.join(dir, 'crop.png');
    const box = panelCrop(FIXTURE, { hp: 2 });
    expect(await writeCrop(file, box, out)).toBe(out);
    const cropped = await readPixels(out);
    // A 102x1285 strip: its long side is already between the floor and the
    // ceiling, so it is written out at its own size and its own shape.
    expect(cropped.height).toBe(PLATE_H);
    expect(cropped.width / cropped.height).toBeCloseTo(PLATE_W / PLATE_H, 2);
    // Backdrop-free: the whole of it is plate now.
    expect(backgroundLevel(cropped)).toBeGreaterThan(PLATE - 20);
    expect(backgroundLevel(cropped)).toBeLessThan(PLATE + 20);
  });

  it('returns nothing when there is no file to crop', async () => {
    expect(
      await writeCrop(path.join(dir, 'missing.png'), { x: 0, y: 0, w: 1, h: 1 }, path.join(dir, 'x.png'))
    ).toBeNull();
  });
});
