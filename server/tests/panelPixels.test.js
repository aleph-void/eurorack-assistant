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
  discScore,
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
// The maker's name down at the bottom of the plate: a compact blob of ink
// about the size and darkness of a jack, sitting in clean plate the way a jack
// sits in its nut. The one thing on a panel that can out-argue a jack for a
// marker that has been dropped past it, and the reason the real 2hp 3:1 had
// its OUT marker printed on the logo instead of the socket.
const LOGO_MM = 110;

// The mounting slots, ~3mm in from each end of the plate: real holes in real
// metal, which is why they have to be ruled out by where they are rather than
// by how they look.
const SLOT_MM = 3;

function drawFixture({ controls = CONTROLS, logo = true, slots = false } = {}) {
  const gray = Buffer.alloc(IMAGE_W * IMAGE_H, BACKDROP);
  const set = (x, y, value) => {
    if (x < 0 || y < 0 || x >= IMAGE_W || y >= IMAGE_H) return;
    gray[y * IMAGE_W + x] = value;
  };
  for (let y = PAD_Y; y < PAD_Y + PLATE_H; y++) {
    for (let x = PAD_X; x < PAD_X + PLATE_W; x++) set(x, y, PLATE);
  }
  const centreX = PAD_X + PLATE_W / 2;
  for (const control of controls) {
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
  if (logo) {
    const logoY = PAD_Y + LOGO_MM * PX_PER_MM;
    for (let dy = -11; dy <= 11; dy++) {
      for (let dx = -11; dx <= 11; dx++) {
        if ((dx + 11) % 5 < 3) set(Math.round(centreX + dx), Math.round(logoY + dy), HARDWARE);
      }
    }
  }
  if (slots) {
    // An M3 slot: 3.2mm across the short way, elongated sideways so the panel
    // can slide on the rail. Big enough that a disc laid over it sees one
    // uniform dark thing, which is exactly why it scores like a jack.
    const halfHeight = Math.round(1.6 * PX_PER_MM);
    for (const mm of [SLOT_MM, PANEL_MM_HEIGHT - SLOT_MM]) {
      const cy = PAD_Y + mm * PX_PER_MM;
      for (let dy = -halfHeight; dy <= halfHeight; dy++) {
        for (let dx = -28; dx <= 28; dx++) {
          if (dy * dy + Math.max(0, Math.abs(dx) - 12) ** 2 <= halfHeight ** 2) {
            set(Math.round(centreX + dx), Math.round(cy + dy), HARDWARE);
          }
        }
      }
    }
  }
  return gray;
}

const FIXTURE = { width: IMAGE_W, height: IMAGE_H, gray: drawFixture() };

// The same plate bolted into a rack: mounting slots at both ends, and the
// output jack down near the bottom one where a lost marker can see both.
const SLOT_CONTROLS = [...CONTROLS.slice(0, -1), { name: 'OUT', shape: 'jack', mm: 115 }];
const SLOTTED = {
  width: IMAGE_W,
  height: IMAGE_H,
  gray: drawFixture({ controls: SLOT_CONTROLS, logo: false, slots: true }),
};

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

  // The failure this shape of backdrop used to cause: lit with falloff, the
  // backdrop darkens smoothly down the frame by twice the trim tolerance.
  // Against the frame-wide background level the darker lower reaches read as
  // content — the bottom edge never trimmed, and every column inherited
  // those pixels so the sides never trimmed either. Only the clean top edge
  // ever moved. Locally the gradient is as uniform as any backdrop, so the
  // whole frame peels; the plate is drawn bolted in (mounting slots at both
  // ends, like every real panel) because down where the falloff meets the
  // plate's own level it is the bottom screws, not the bare metal, that the
  // peel stops at.
  it('trims all four edges of a shot on a gradient backdrop', () => {
    const gray = drawFixture({ slots: true });
    for (let y = 0; y < IMAGE_H; y++) {
      const shade = BACKDROP - Math.round((y / IMAGE_H) * 40);
      for (let x = 0; x < IMAGE_W; x++) {
        if (gray[y * IMAGE_W + x] === BACKDROP) gray[y * IMAGE_W + x] = shade;
      }
    }
    const box = trimBox({ width: IMAGE_W, height: IMAGE_H, gray });
    expect(box.x * IMAGE_W).toBeCloseTo(PAD_X, 0);
    expect(box.y * IMAGE_H).toBeCloseTo(PAD_Y, 0);
    expect(box.w * IMAGE_W).toBeCloseTo(PLATE_W, 0);
    // The bottom may rest on the bottom mounting slot rather than the last
    // millimetres of bare plate — within 5mm of the true edge is a trim, not
    // the miss this exercises (the box used to run to the frame's edge).
    const bottom = (box.y + box.h) * IMAGE_H;
    expect(bottom).toBeGreaterThan(PAD_Y + PLATE_H - 5 * PX_PER_MM);
    expect(bottom).toBeLessThanOrEqual(PAD_Y + PLATE_H + 1);
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
  const PLATE_BOUNDS = {
    x0: Math.round(crop.x * IMAGE_W),
    y0: Math.round(crop.y * IMAGE_H),
    x1: Math.round((crop.x + crop.w) * IMAGE_W) - 1,
    y1: Math.round((crop.y + crop.h) * IMAGE_H) - 1,
  };

  it('scores the hardware itself above anything else nearby', () => {
    const control = CONTROLS[0];
    const cx = Math.round(truth(control).x * IMAGE_W);
    const cy = Math.round(truth(control).y * IMAGE_H);
    const r = Math.round(RADIUS_MM.jack * PX_PER_MM);
    const found = findDisc(FIXTURE, PLATE_BOUNDS, cx, cy + 27, r, 35);
    expect(found.score).toBeGreaterThan(MIN_CONTRAST);
    expect(found.y).toBeCloseTo(cy, 6);
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

  it('does not mistake a blob of silkscreen for a piece of hardware', () => {
    // Ink and bare plate alternating averages out darker than the plate, so a
    // logo reads as a dark round thing on the contrast alone. What it cannot
    // fake is a middle made of one thing, and that is what is being asked.
    const r = Math.round(RADIUS_MM.jack * PX_PER_MM);
    const cx = Math.round((PAD_X + PLATE_W / 2));
    const onHardware = discScore(FIXTURE, PLATE_BOUNDS, cx, Math.round(PAD_Y + CONTROLS[0].mm * PX_PER_MM), r);
    const onLogo = discScore(FIXTURE, PLATE_BOUNDS, cx, Math.round(PAD_Y + LOGO_MM * PX_PER_MM), r);
    expect(onHardware).toBeGreaterThan(MIN_CONTRAST);
    expect(onLogo).toBeLessThan(MIN_CONTRAST);
  });

  it('brings back a marker the model dropped a whole component low', () => {
    // The 2hp 3:1 failure exactly: OUT placed 8mm below its socket, which puts
    // it between the OUT lettering and the maker's logo and well past the
    // half-HP the snap used to reach. Both of the things it is now sitting
    // between are printing, and the socket above it is not.
    const out = CONTROLS.at(-1);
    const placements = [
      ...CONTROLS.slice(0, -1).map((c) => asModelWouldSay(c)),
      asModelWouldSay(out, 8),
    ];
    expect(mmOff(placements.at(-1), out, crop)).toBeGreaterThan(7);
    const snap = snapPlacements(FIXTURE, placements, crop);
    expect(snap.snapped).toBe(CONTROLS.length);
    expect(mmOff(snap.placements.at(-1), out, crop)).toBeLessThan(0.2);
  });

  it('will not let two markers claim the same piece of hardware', () => {
    // A socket with two markers reaching for it: one sitting on it, one 5mm
    // below. Without the rule, a search wide enough to rescue a lost marker is
    // also wide enough to pile the panel's markers onto whichever hole they
    // can all see.
    const socket = CONTROLS[2];
    const placements = [
      ...CONTROLS.slice(0, 2).map((c) => asModelWouldSay(c)),
      { name: socket.name, shape: 'jack', ...truth(socket) },
      { name: 'STRAY', shape: 'jack', ...asModelWouldSay(socket, 5) },
    ];
    const snap = snapPlacements(FIXTURE, placements, crop);
    expect(snap.snapped).toBe(3);
    expect(mmOff(snap.placements[2], socket, crop)).toBeLessThan(0.2);
    // The nearer marker keeps the socket; the other stays where it was rather
    // than being planted on top of it.
    expect(mmOff(snap.placements[3], socket, crop)).toBeGreaterThan(3);
  });

  it('will not snap a marker into the mounting slot at the end of the plate', () => {
    // The slot is a real hole in real metal and scores like one, and to a
    // marker the model dropped past the last jack it is the nearer of the two.
    // Nothing can be bolted through the rail, so it is ruled out on geometry.
    const out = SLOT_CONTROLS.at(-1);
    const placements = [
      ...SLOT_CONTROLS.slice(0, -1).map((c) => asModelWouldSay(c)),
      // 8mm low: 2.5mm from the mounting slot, and past where the old
      // half-HP window could have reached its own jack from.
      asModelWouldSay(out, 8),
    ];
    const snap = snapPlacements(SLOTTED, placements, crop);
    expect(mmOff(snap.placements.at(-1), out, crop)).toBeLessThan(0.2);
  });

  it('follows a drift that grows down the panel rather than averaging it away', () => {
    // The model read the top of the panel well and lost its place towards the
    // bottom, which is how the errors on a real panel actually arrive. An LED
    // between a control that did not move and one that moved 8mm should come
    // back by the share of 8mm that its own position asks for — a single
    // panel-wide median would give it the whole panel's answer, which is
    // roughly nothing.
    const [cv, out] = [CONTROLS[2], CONTROLS[3]];
    const ledMm = (cv.mm + out.mm) / 2;
    const placements = [
      ...CONTROLS.slice(0, 3).map((c) => asModelWouldSay(c, 0)),
      asModelWouldSay(out, 8),
      // Sits midway between CV and OUT, and the model dropped it by half of
      // what it dropped OUT by.
      { name: 'LED', shape: 'display', x: truth(cv).x, y: (PAD_Y + (ledMm + 4) * PX_PER_MM) / IMAGE_H },
    ];
    const snap = snapPlacements(FIXTURE, placements, crop);
    expect(snap.snapped).toBe(4);
    expect(snap.shifted).toBe(1);
    expect(mmOff(snap.placements.at(-1), { mm: ledMm }, crop)).toBeLessThan(0.5);
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
