// Front panels: sniffing a downloaded image, locating components on it,
// drawing the logical panel when there is no image, and the job + routes that
// tie the two together.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestApp,
  createTestDb,
  createUser,
  fakeBackend,
  fakeFetch,
  insertModule,
  login,
  PDF_BYTES,
  PDF_HASH,
} from './helpers.js';
import {
  downloadImage,
  readCappedBuffer,
  panelPath,
  saveImage,
  sniffImage,
} from '../src/services/image.js';
import { loadSharp } from '../src/services/panelPixels.js';
import { HP_MM, PANEL_MM_HEIGHT } from '../src/services/panelGeometry.js';
import {
  buildPanelForModule,
  fallbackLayout,
  fillMissingPlacements,
  normalizeCrop,
  normalizeHp,
  normalizePlacements,
  renderPanelSvg,
} from '../src/services/panelImage.js';
import { createWorker, enqueueJob } from '../src/jobs/worker.js';

// A structurally valid PNG of the given size. Only the signature and the IHDR
// header are ever read (nothing here decodes pixels), but the CRCs are real so
// the file is a genuine PNG rather than a shape that happens to parse.
function pngBytes(width, height) {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const row = Buffer.alloc(width + 1);
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PANEL_PNG = pngBytes(400, 1200);

const COMPONENTS = [
  { name: '1V/OCT', type: 'input_jack' },
  { name: 'FM', type: 'input_jack' },
  { name: 'SAW', type: 'output_jack' },
  { name: 'FREQ', type: 'knob' },
  { name: 'WAVE', type: 'switch' },
];

// A module with a manual on disk and an analyzed component list — the state
// the panel job runs against.
async function analyzedModule(db, manualsDir, fields = {}) {
  const user = await createUser(db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  const module = await insertModule(db, user.id, {
    manufacturer: 'Doepfer',
    name: 'A-110',
    manual_hash: PDF_HASH,
    analysis_status: 'complete',
    ...fields,
  });
  fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
  await db.models.ModuleComponent.bulkCreate(
    COMPONENTS.map((c) => ({ ...c, module_id: module.id }))
  );
  return { user, module };
}

describe('image sniffing', () => {
  it('reads a PNG\'s format and size out of its own bytes', () => {
    expect(sniffImage(PANEL_PNG)).toEqual({ ext: 'png', width: 400, height: 1200 });
  });

  it('rejects anything that is not an image we serve', () => {
    expect(sniffImage(PDF_BYTES)).toBe(null);
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(null);
  });

  it('reads a JPEG\'s size from its start-of-frame segment', () => {
    // SOI, an APP0 segment to skip past, then a SOF0 stating 640x480.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80]),
      Buffer.alloc(16),
    ]);
    expect(sniffImage(jpeg)).toEqual({ ext: 'jpg', width: 640, height: 480 });
  });

  it('steps over JPEG padding and standalone markers on the way to the frame', () => {
    const tricky = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xff, 0x01]), // padding run, then a standalone TEM
      Buffer.from([0x00]), // stray byte between segments
      Buffer.from([0xff, 0xd0]), // standalone RST0
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00]),
      Buffer.alloc(16),
    ]);
    expect(sniffImage(tricky)).toEqual({ ext: 'jpg', width: 512, height: 256 });
  });

  it('reads GIF headers and all three WebP flavours', () => {
    const gif = Buffer.alloc(20);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(sniffImage(gif)).toEqual({ ext: 'gif', width: 320, height: 240 });

    const webp = (chunk, fill) => {
      const buf = Buffer.alloc(40);
      buf.write('RIFF', 0, 'latin1');
      buf.write('WEBP', 8, 'latin1');
      buf.write(chunk, 12, 'latin1');
      fill(buf);
      return buf;
    };
    const lossy = webp('VP8 ', (b) => {
      b.writeUInt16LE(500, 26);
      b.writeUInt16LE(300, 28);
    });
    expect(sniffImage(lossy)).toEqual({ ext: 'webp', width: 500, height: 300 });
    // Lossless packs both dimensions minus one into a single bitfield.
    const lossless = webp('VP8L', (b) => b.writeUInt32LE(399 | (199 << 14), 21));
    expect(sniffImage(lossless)).toEqual({ ext: 'webp', width: 400, height: 200 });
    const extended = webp('VP8X', (b) => {
      b.writeUIntLE(799, 24, 3);
      b.writeUIntLE(599, 27, 3);
    });
    expect(sniffImage(extended)).toEqual({ ext: 'webp', width: 800, height: 600 });
    // A RIFF container whose first chunk is not a VP8 bitstream says nothing.
    expect(sniffImage(webp('ALPH', () => {}))).toBe(null);
  });

  it('rejects magic numbers whose headers do not parse', () => {
    expect(sniffImage(null)).toBe(null);
    expect(sniffImage(Buffer.from('GIF89a'))).toBe(null); // shorter than any header

    // A PNG whose first chunk is not IHDR, and one that is zero pixels wide.
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const notIhdr = Buffer.alloc(24);
    pngSig.copy(notIhdr);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(sniffImage(notIhdr)).toBe(null);
    const zeroWide = Buffer.alloc(24);
    pngSig.copy(zeroWide);
    zeroWide.write('IHDR', 12, 'latin1');
    zeroWide.writeUInt32BE(0, 16);
    zeroWide.writeUInt32BE(600, 20);
    expect(sniffImage(zeroWide)).toBe(null);

    // A spacer GIF with zeroed dimensions.
    const spacer = Buffer.alloc(20);
    spacer.write('GIF89a', 0, 'latin1');
    expect(sniffImage(spacer)).toBe(null);

    // A JPEG with a corrupt segment length, and one that runs out of bytes
    // before any start-of-frame.
    expect(
      sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]))
    ).toBe(null);
    expect(
      sniffImage(
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40]), Buffer.alloc(16)])
      )
    ).toBe(null);
  });
});

describe('capped body reads', () => {
  const streamed = (chunks, contentLength = null) => {
    const state = { cancelled: false, read: false };
    return {
      state,
      res: {
        headers: { get: () => (contentLength === null ? null : String(contentLength)) },
        body: {
          getReader: () => {
            state.read = true;
            let i = 0;
            return {
              read: async () =>
                i >= chunks.length
                  ? { done: true, value: undefined }
                  : { done: false, value: chunks[i++] },
              cancel: async () => {
                state.cancelled = true;
              },
            };
          },
        },
      },
    };
  };

  it('streams a body under the cap into one buffer', async () => {
    const { res } = streamed([Buffer.from('front '), Buffer.from('panel')]);
    expect((await readCappedBuffer(res, 100)).toString()).toBe('front panel');
  });

  it('aborts a stream the moment it passes the cap', async () => {
    const { res, state } = streamed([Buffer.alloc(8), Buffer.alloc(8)]);
    await expect(readCappedBuffer(res, 10)).rejects.toThrow(/exceeds 10 byte limit/);
    expect(state.cancelled).toBe(true);
  });

  it('rejects an oversized Content-Length before reading a single byte', async () => {
    const { res, state } = streamed([Buffer.alloc(8)], 999);
    await expect(readCappedBuffer(res, 10)).rejects.toThrow(/declared length 999/);
    expect(state.read).toBe(false);
  });

  it('caps a body that arrives without a stream too', async () => {
    const res = {
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new Uint8Array(16).buffer,
    };
    await expect(readCappedBuffer(res, 10)).rejects.toThrow(/exceeds 10 byte limit/);
  });
});

describe('downloadImage', () => {
  const toArrayBuffer = (buf) =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const imageResponse = (bytes) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => toArrayBuffer(bytes),
  });
  const refusal = { ok: false, status: 403, headers: { get: () => null }, body: null };

  it('retries with Chrome desktop headers when the plain fetch is refused', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts.headers);
      return calls.length === 1 ? refusal : imageResponse(PANEL_PNG);
    };
    const logs = [];
    const result = await downloadImage('https://example.com/panel.png', {
      fetchImpl,
      log: (m) => logs.push(m),
    });
    expect(result).toMatchObject({
      ext: 'png',
      width: 400,
      height: 1200,
      url: 'https://example.com/panel.png',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]['User-Agent']).toBeTruthy();
    expect(calls[0].Referer).toBeUndefined();
    expect(calls[1].Referer).toBe('https://example.com/');
    expect(logs.some((m) => /HTTP 403/.test(m))).toBe(true);
    expect(logs.some((m) => /retrying with Chrome desktop headers/.test(m))).toBe(true);
  });

  it('returns null when both attempts fail, or the bytes are no panel', async () => {
    expect(
      await downloadImage('https://example.com/a.png', { fetchImpl: async () => refusal })
    ).toBe(null);

    const notImage = async () => imageResponse(Buffer.from('<html>a panel, honest</html>'));
    const htmlLogs = [];
    expect(
      await downloadImage('https://example.com/a.png', {
        fetchImpl: notImage,
        log: (m) => htmlLogs.push(m),
      })
    ).toBe(null);
    expect(htmlLogs.some((m) => /not a PNG, JPEG, GIF or WebP/.test(m))).toBe(true);

    const thumb = async () => imageResponse(pngBytes(32, 32));
    const thumbLogs = [];
    expect(
      await downloadImage('https://example.com/a.png', {
        fetchImpl: thumb,
        log: (m) => thumbLogs.push(m),
      })
    ).toBe(null);
    expect(thumbLogs.some((m) => /too small to be a panel image/.test(m))).toBe(true);

    // A blocked address logs as blocked and never reaches the fetch at all.
    const blockedLogs = [];
    let fetched = false;
    expect(
      await downloadImage('https://169.254.169.254/panel.png', {
        fetchImpl: async () => {
          fetched = true;
          return refusal;
        },
        log: (m) => blockedLogs.push(m),
      })
    ).toBe(null);
    expect(fetched).toBe(false);
    expect(blockedLogs.filter((m) => /image download blocked/.test(m))).toHaveLength(2);
    expect(blockedLogs.some((m) => /image download failed/.test(m))).toBe(false);
  });
});

describe('placement normalization', () => {
  const components = COMPONENTS.map((c, i) => ({ ...c, id: i + 1 }));

  it('matches placements to components loosely and clamps them to the image', () => {
    const placements = normalizePlacements(
      [
        { name: '1v oct', x: 0.5, y: 0.9 },
        { name: 'Freq', x: 1.4, y: -0.2, shape: 'knob' },
      ],
      components
    );
    expect(placements[0]).toMatchObject({ component_id: 1, name: '1V/OCT', shape: 'jack' });
    expect(placements[1]).toMatchObject({ component_id: 4, name: 'FREQ', shape: 'knob', x: 1, y: 0 });
  });

  it('keeps a placement whose name matches nothing, without a component', () => {
    const placements = normalizePlacements([{ name: 'LED', x: 0.5, y: 0.1 }], components);
    expect(placements).toEqual([
      { component_id: null, name: 'LED', shape: 'other', x: 0.5, y: 0.1, w: 0.06, h: 0.06 },
    ]);
  });

  it('places the same component only once', () => {
    const placements = normalizePlacements(
      [
        { name: 'SAW', x: 0.2, y: 0.8 },
        { name: 'saw', x: 0.7, y: 0.8 },
      ],
      components
    );
    expect(placements).toHaveLength(1);
  });

  it('drops entries with no position at all', () => {
    expect(normalizePlacements([{ name: 'SAW' }, null, 'nonsense'], components)).toEqual([]);
  });

  // A jack with no position cannot be patched in the diagram, so anything the
  // LLM left out is given a place of its own below what it did place.
  it('fills in components the LLM did not place', () => {
    const filled = fillMissingPlacements(
      normalizePlacements([{ name: 'FREQ', x: 0.5, y: 0.2 }], components),
      components
    );
    expect(filled.map((p) => p.component_id).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const p of filled) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  // A crop is what turns a product photo into a panel; a bad one turns it
  // into a sliver of background.
  it('turns the panel box into an origin and size, and rejects a degenerate one', () => {
    const box = normalizeCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.8 });
    expect(box.crop_x).toBeCloseTo(0.3);
    expect(box.crop_y).toBeCloseTo(0.1);
    expect(box.crop_w).toBeCloseTo(0.4);
    expect(box.crop_h).toBeCloseTo(0.8);
    // Too small to be a panel, missing, or unparseable — show the whole image.
    expect(normalizeCrop({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 })).toEqual({
      crop_x: 0,
      crop_y: 0,
      crop_w: 1,
      crop_h: 1,
    });
    expect(normalizeCrop(undefined)).toEqual({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 });
    // A box hanging off the edge is trimmed back to the image.
    const edge = normalizeCrop({ x: 0.9, y: 0.5, w: 0.4, h: 1 });
    expect(edge.crop_x).toBeCloseTo(0.7);
    expect(edge.crop_w).toBeCloseTo(0.3);
  });

  it('rounds a panel width to the nearest half HP and refuses nonsense', () => {
    expect(normalizeHp(8)).toBe(8);
    expect(normalizeHp('12.3')).toBe(12.5);
    expect(normalizeHp(0)).toBe(null);
    expect(normalizeHp('wide')).toBe(null);
    expect(normalizeHp(500)).toBe(84);
  });
});

describe('drawing a logical panel', () => {
  const components = COMPONENTS.map((c, i) => ({ ...c, id: i + 1 }));

  it('lays controls above jacks when there is nothing else to go on', () => {
    const placements = fallbackLayout(components);
    const jackY = placements.filter((p) => p.shape === 'jack').map((p) => p.y);
    const controlY = placements.filter((p) => p.shape !== 'jack').map((p) => p.y);
    expect(Math.min(...jackY)).toBeGreaterThan(Math.max(...controlY));
  });

  it('draws an SVG sized from the HP width with a marker per component', () => {
    const { svg, width, height } = renderPanelSvg({
      manufacturer: 'Doepfer',
      name: 'A-110',
      hp: 8,
      placements: fallbackLayout(components),
    });
    // 8HP x 5.08mm, 128.5mm tall, at 8 units per millimetre.
    expect(width).toBe(325);
    expect(height).toBe(1028);
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    for (const c of COMPONENTS) expect(svg).toContain(c.name);
  });

  it('escapes names rather than letting them become markup', () => {
    const { svg } = renderPanelSvg({
      manufacturer: 'X',
      name: 'Y',
      hp: 4,
      placements: [{ component_id: 1, name: '<script>x</script>', shape: 'jack', x: 0.5, y: 0.5, w: 0.06, h: 0.06 }],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('building a module panel', () => {
  let db;
  let manualsDir;
  let panelsDir;

  beforeEach(async () => {
    db = await createTestDb();
    manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-manuals-'));
    panelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-images-'));
  });
  afterEach(() => {
    fs.rmSync(manualsDir, { recursive: true, force: true });
    fs.rmSync(panelsDir, { recursive: true, force: true });
  });

  const research = JSON.stringify({
    image_urls: ['https://doepfer.de/a110.png'],
    page_url: 'https://doepfer.de/a110.html',
    hp: 8,
  });

  it('uses a found image and the positions located on it', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: JSON.stringify({
        is_panel: true,
        panel: { x: 0.5, y: 0.5, w: 0.8, h: 1 },
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.1 * (i + 1) })),
      }),
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'doepfer.de/a110.png': { body: PANEL_PNG } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('image');
    expect(panel.image_ext).toBe('png');
    expect(panel.width).toBe(400);
    expect(panel.height).toBe(1200);
    expect(panel.crop_x).toBeCloseTo(0.1);
    expect(panel.crop_w).toBeCloseTo(0.8);
    expect(panel.hp).toBe(8);
    expect(placements).toHaveLength(5);
    expect(fs.existsSync(panelPath(panelsDir, panel.image_hash, 'png'))).toBe(true);

    const stored = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(stored.source).toBe('image');
    expect(
      await db.models.ModulePanelComponent.count({ where: { panel_id: stored.id } })
    ).toBe(5);
    const after = await db.models.Module.findByPk(module.id);
    expect(after.panel_status).toBe('complete');
  });

  // A real photograph rather than the flat rectangle the rest of these use:
  // a 2HP plate on a backdrop with four dark controls down it, so the crop,
  // the mapping and the snap all have something to actually measure.
  async function platePng() {
    const sharp = await loadSharp();
    const width = 500;
    const height = 1500;
    const plate = { x0: 200, x1: 301, y0: 100, y1: 1385 }; // 102 x 1286, a 2HP plate
    const gray = Buffer.alloc(width * height, 250);
    for (let y = plate.y0; y <= plate.y1; y++) {
      for (let x = plate.x0; x <= plate.x1; x++) gray[y * width + x] = 200;
    }
    const cx = (plate.x0 + plate.x1) / 2;
    const controls = [];
    for (const [i, name] of ['1V/OCT', 'FM', 'FREQ', 'SAW'].entries()) {
      const cy = plate.y0 + 250 * (i + 1);
      const r = 22;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) gray[Math.round(cy + dy) * width + Math.round(cx + dx)] = 20;
        }
      }
      controls.push({ name, x: cx / width, y: cy / height });
    }
    const buffer = await sharp(gray, { raw: { width, height, channels: 1 } }).png().toBuffer();
    return { buffer, controls, plate, width, height };
  }

  it('crops the plate out of the photograph, then snaps the markers onto the hardware', async () => {
    const { module } = await analyzedModule(db, manualsDir, { hp: 2 });
    const fixture = await platePng();
    // What a model says about the cropped picture: the right controls, each
    // dragged 30px down towards where its silkscreen name would be.
    const cropped = { x0: 194, y0: 61, w: 114, h: 1363 };
    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: () =>
        JSON.stringify({
          is_panel: true,
          components: fixture.controls.map((c) => ({
            name: c.name,
            x: (c.x * fixture.width - cropped.x0) / cropped.w,
            y: (c.y * fixture.height + 30 - cropped.y0) / cropped.h,
          })),
        }),
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'doepfer.de/a110.png': { body: fixture.buffer } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('image');
    // The crop is the plate itself, measured off the picture rather than
    // taken from the model's answer (which was not even asked for it).
    expect(panel.crop_x * fixture.width).toBeCloseTo(fixture.plate.x0, 0);
    expect(panel.crop_w * fixture.width).toBeCloseTo(102, 0);
    expect(panel.crop_h * fixture.height).toBeCloseTo(1286, 0);
    // The model was shown the crop, and told it did not need to find the panel.
    const [prompt, file] = backend.calls.analyzeImage.at(-1);
    expect(prompt).toContain('already been cropped');
    expect(prompt).not.toContain('"panel"');
    expect(file).not.toBe(panelPath(panelsDir, panel.image_hash, 'png'));
    // Its 30px drift is gone: every marker is back on its control, to within
    // a millimetre (a plate is 128.5mm over 1286px here, so ~10px/mm), and in
    // fractions of the whole image rather than of the crop it was mapped on.
    for (const control of fixture.controls) {
      const placed = placements.find((p) => p.name === control.name);
      expect(Math.abs(placed.y * fixture.height - control.y * fixture.height)).toBeLessThan(10);
      expect(Math.abs(placed.x * fixture.width - control.x * fixture.width)).toBeLessThan(10);
    }
    // And the temporary crop it was shown does not outlive the job.
    expect(fs.readdirSync(panelsDir).filter((f) => f.endsWith('.png'))).toHaveLength(1);
  });

  // A picture of something else is worse than no picture: the drawn panel is
  // at least the right module.
  it('draws the panel from the manual when the image is not this module', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: JSON.stringify({ is_panel: false, components: [] }),
      analyzeDocument: JSON.stringify({
        hp: 12,
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
      }),
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'doepfer.de/a110.png': { body: PANEL_PNG } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('generated');
    expect(panel.image_ext).toBe('svg');
    expect(panel.hp).toBe(12);
    expect(placements).toHaveLength(5);
    // The rejected photograph is not left lying in the panels directory.
    expect(fs.readdirSync(panelsDir).filter((f) => f.endsWith('.png'))).toEqual([]);
    const svg = fs.readFileSync(panelPath(panelsDir, panel.image_hash, 'svg'), 'utf-8');
    expect(svg).toContain('1V/OCT');
  });

  // ModularGrid is a rack planner rather than a source, so it is asked only
  // once the maker and the retailers have come up empty — but a real picture
  // of the right module from there still beats the drawing.
  it('falls back to ModularGrid when nothing else has a picture', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      // The first prompt names ModularGrid too, to rule it out; the fallback
      // is the one that says the other searches came up empty.
      completeTextWithSearch: (prompt) =>
        /did not have one/.test(prompt)
          ? JSON.stringify({
              image_urls: ['https://cdn.modulargrid.net/img/modules/a110.png'],
              page_url: 'https://modulargrid.net/e/doepfer-a-110',
              hp: 8,
            })
          : JSON.stringify({ image_urls: [], page_url: null, hp: null }),
      analyzeImage: JSON.stringify({
        is_panel: true,
        panel: { x: 0.5, y: 0.5, w: 1, h: 1 },
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.1 * (i + 1) })),
      }),
    });
    const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'modulargrid.net/img/modules/a110.png': { body: PANEL_PNG } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(backend.calls.completeTextWithSearch).toHaveLength(2);
    expect(panel.source).toBe('image');
    expect(panel.source_url).toContain('modulargrid.net');
    expect(panel.hp).toBe(8);
  });

  it('does not go to ModularGrid when the manufacturer had a picture', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: JSON.stringify({
        is_panel: true,
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.1 * (i + 1) })),
      }),
    });
    await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'doepfer.de/a110.png': { body: PANEL_PNG } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });
    expect(backend.calls.completeTextWithSearch).toHaveLength(1);
  });

  it('rejects an angled candidate and keeps searching for a front-panel view', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        image_urls: ['https://doepfer.de/a110-hero.png', 'https://doepfer.de/a110-front.png'],
        page_url: 'https://doepfer.de/a110.html',
        hp: 8,
      }),
      analyzeImage: () =>
        JSON.stringify(
          backend.calls.analyzeImage.length === 1
            ? { is_panel: false, components: [] }
            : {
                is_panel: true,
                components: COMPONENTS.map((c, i) => ({
                  name: c.name,
                  x: 0.5,
                  y: 0.1 * (i + 1),
                })),
              }
        ),
    });

    const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({
        'doepfer.de/a110-hero.png': { body: PANEL_PNG },
        'doepfer.de/a110-front.png': { body: PANEL_PNG },
      }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('image');
    expect(panel.source_url).toBe('https://doepfer.de/a110-front.png');
    expect(backend.calls.analyzeImage).toHaveLength(2);
    expect(fs.readdirSync(panelsDir).filter((file) => file.endsWith('.png'))).toHaveLength(1);
  });

  // Neither search found a picture, but one of them did read the width off a
  // page, and a module with no recorded HP still wants it.
  it('keeps a width learnt while researching even when no image came of it', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({ image_urls: [], page_url: null, hp: 14 }),
      analyzeDocument: 'the model did not answer with JSON',
    });
    const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({}),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });
    expect(panel.source).toBe('generated');
    expect(panel.hp).toBe(14);
  });

  // The failure that matters: a provider that is not answering fails every
  // call the same way a fruitless search does. Read as "found nothing", it
  // replaces every photographed panel in a rack with a drawing and deletes
  // the photographs — which is what a rebuild across a whole system did the
  // first time the subscription ran out of credits mid-run.
  describe('when the model is not answering at all', () => {
    // What `claude -p` prints when the subscription is spent. It says this on
    // STDOUT and then exits 1, so runCli rejects — which is why the tally has
    // to count a call on the way out and not on the way back.
    const OUT_OF_CREDITS =
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
    const silentBackend = ({ throws = true } = {}) => {
      // Either shape of not-answering: the CLI exiting non-zero (what the
      // real one does), or returning prose where JSON was asked for.
      const response = throws
        ? new Error(`claude failed (exit 1):\n${OUT_OF_CREDITS}`)
        : OUT_OF_CREDITS;
      return fakeBackend({
        completeTextWithSearch: response,
        analyzeImage: response,
        analyzeDocument: response,
      });
    };

    it('fails the panel instead of drawing one over the photograph it had', async () => {
      const { module } = await analyzedModule(db, manualsDir);
      // A module that already has a researched photograph, as a rebuild finds it.
      await db.models.ModulePanel.create({
        module_id: module.id,
        source: 'image',
        source_url: 'https://doepfer.de/a110.png',
        image_hash: 'a'.repeat(64),
        image_ext: 'png',
        width: 400,
        height: 1200,
        hp: 8,
      });
      fs.writeFileSync(panelPath(panelsDir, 'a'.repeat(64), 'png'), PANEL_PNG);

      await expect(
        buildPanelForModule(db, silentBackend(), module, panelsDir, {
          fetchImpl: fakeFetch({}),
          manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
        })
      ).rejects.toThrow(/came back readable/);

      // The panel it had is exactly where it was, image and all.
      const kept = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });
      expect(kept.source).toBe('image');
      expect(fs.existsSync(panelPath(panelsDir, 'a'.repeat(64), 'png'))).toBe(true);
    });

    it('leaves the markers on an uploaded picture alone', async () => {
      const { module } = await analyzedModule(db, manualsDir);
      const hash = saveImage(panelsDir, PANEL_PNG, 'png');
      const panel = await db.models.ModulePanel.create({
        module_id: module.id,
        source: 'upload',
        image_hash: hash,
        image_ext: 'png',
        width: 400,
        height: 1200,
      });
      await db.models.ModulePanelComponent.create({
        panel_id: panel.id,
        name: 'FREQ',
        shape: 'knob',
        x: 0.5,
        y: 0.5,
        w: 0.06,
        h: 0.06,
      });

      await expect(
        buildPanelForModule(db, silentBackend(), module, panelsDir, {
          fetchImpl: fakeFetch({}),
          manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
        })
      ).rejects.toThrow(/came back readable/);

      expect(await db.models.ModulePanelComponent.count({ where: { panel_id: panel.id } })).toBe(1);
      expect(fs.existsSync(panelPath(panelsDir, hash, 'png'))).toBe(true);
    });

    it('fails the same way when the CLI answers with prose instead of exiting', async () => {
      const { module } = await analyzedModule(db, manualsDir);
      await expect(
        buildPanelForModule(db, silentBackend({ throws: false }), module, panelsDir, {
          fetchImpl: fakeFetch({}),
          manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
        })
      ).rejects.toThrow(/came back readable/);
    });

    // The point is to tell an outage from an answer, not to stop drawing
    // panels: a model that answers and simply has no picture still gets one.
    it('still draws a panel when the model answers and has nothing to offer', async () => {
      const { module } = await analyzedModule(db, manualsDir);
      const backend = fakeBackend({
        completeTextWithSearch: JSON.stringify({ image_urls: [], page_url: null, hp: null }),
        analyzeDocument: JSON.stringify({ hp: 6, components: [] }),
      });
      const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
        fetchImpl: fakeFetch({}),
        manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
      });
      expect(panel.source).toBe('generated');
    });
  });

  it('draws the panel from the component list when there is no image and no layout', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({ image_urls: [], page_url: null, hp: null }),
      analyzeDocument: 'the model did not answer with JSON',
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({}),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('generated');
    expect(panel.hp).toBeGreaterThan(0);
    expect(placements.map((p) => p.component_id).filter(Boolean)).toHaveLength(5);
  });

  it('replaces the previous panel and removes its orphaned image', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: JSON.stringify({
        is_panel: true,
        components: COMPONENTS.map((c) => ({ name: c.name, x: 0.5, y: 0.5 })),
      }),
      analyzeDocument: JSON.stringify({ hp: 8, components: [{ name: 'FREQ', x: 0.5, y: 0.2 }] }),
    });
    const fetchImpl = fakeFetch({ 'doepfer.de/a110.png': { body: PANEL_PNG } });
    const first = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl,
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });
    expect(first.panel.source).toBe('image');

    // Second run: no image this time, so the drawn panel takes over and the
    // photograph nothing references any more goes with it.
    const second = await buildPanelForModule(
      db,
      fakeBackend({
        completeTextWithSearch: JSON.stringify({ image_urls: [] }),
        analyzeDocument: JSON.stringify({ hp: 8, components: [{ name: 'FREQ', x: 0.5, y: 0.2 }] }),
      }),
      module,
      panelsDir,
      { fetchImpl: fakeFetch({}), manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`) }
    );
    expect(second.panel.source).toBe('generated');
    expect(await db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
    expect(fs.existsSync(panelPath(panelsDir, first.panel.image_hash, 'png'))).toBe(false);
  });

  // A picture someone uploaded is a deliberate choice; research is a guess.
  it('keeps an uploaded panel and re-locates the components on it', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const hash = saveImage(panelsDir, PANEL_PNG, 'png');
    await db.models.ModulePanel.create({
      module_id: module.id,
      source: 'upload',
      image_hash: hash,
      image_ext: 'png',
      width: 400,
      height: 1200,
    });

    const backend = fakeBackend({
      completeTextWithSearch: research,
      analyzeImage: JSON.stringify({
        is_panel: true,
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
      }),
      analyzeDocument: JSON.stringify({ hp: 12, components: [] }),
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({ 'doepfer.de/a110.png': { body: PANEL_PNG } }),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('upload');
    expect(panel.image_hash).toBe(hash);
    expect(placements).toHaveLength(5);
    // No research was done at all: the panel was never in question.
    expect(backend.calls.completeTextWithSearch ?? []).toHaveLength(0);
    expect(fs.existsSync(panelPath(panelsDir, hash, 'png'))).toBe(true);
  });

  it('keeps an uploaded panel even when nothing can be located on it', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const hash = saveImage(panelsDir, PANEL_PNG, 'png');
    await db.models.ModulePanel.create({
      module_id: module.id,
      source: 'upload',
      image_hash: hash,
      image_ext: 'png',
      width: 400,
      height: 1200,
    });

    const { panel, placements } = await buildPanelForModule(
      db,
      fakeBackend({ analyzeImage: JSON.stringify({ is_panel: false, components: [] }) }),
      module,
      panelsDir,
      { fetchImpl: fakeFetch({}) }
    );
    expect(panel.source).toBe('upload');
    expect(panel.image_hash).toBe(hash);
    expect(placements).toEqual([]);
    expect(panel.description).toMatch(/could not be located/);
  });

  // The locate call spends its time in an LLM, and the panel is live while it
  // runs: a trim can cut the picture down and delete the old bytes before the
  // markers come back. Saving the job's snapshot then would point the panel at
  // a file that no longer exists — a broken image no button can repair.
  it('does not resurrect a picture a mid-flight trim already replaced', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const hash = saveImage(panelsDir, PANEL_PNG, 'png');
    await db.models.ModulePanel.create({
      module_id: module.id,
      source: 'upload',
      image_hash: hash,
      image_ext: 'png',
      width: 400,
      height: 1200,
    });

    const CUT_PNG = pngBytes(200, 1150);
    let cutHash;
    const backend = fakeBackend({
      // While the model is looking at the picture, a trim lands: the file is
      // cut down, the row re-pointed at the cut, and the old bytes deleted.
      analyzeImage: async () => {
        cutHash = saveImage(panelsDir, CUT_PNG, 'png');
        await db.models.ModulePanel.update(
          { image_hash: cutHash, width: 200, height: 1150, trimmed: true },
          { where: { module_id: module.id } }
        );
        fs.rmSync(panelPath(panelsDir, hash, 'png'));
        return JSON.stringify({
          is_panel: true,
          components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
        });
      },
    });
    const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({}),
    });

    // The newer picture won; the markers worked out against the old bytes
    // went with the old bytes.
    expect(panel.image_hash).toBe(cutHash);
    expect(panel.trimmed).toBe(true);
    expect(placements).toEqual([]);
    expect(await db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
    expect(fs.existsSync(panelPath(panelsDir, cutHash, 'png'))).toBe(true);
  });

  // Re-locating on a panel that has already been cut down to the plate must
  // not reset the flag that stops it being cut a second time.
  it('keeps an already-trimmed panel marked trimmed when re-locating on it', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const hash = saveImage(panelsDir, PANEL_PNG, 'png');
    await db.models.ModulePanel.create({
      module_id: module.id,
      source: 'upload',
      image_hash: hash,
      image_ext: 'png',
      width: 400,
      height: 1200,
      trimmed: true,
    });

    const backend = fakeBackend({
      analyzeImage: JSON.stringify({
        is_panel: true,
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
      }),
    });
    const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({}),
    });
    expect(panel.source).toBe('upload');
    expect(panel.image_hash).toBe(hash);
    expect(panel.trimmed).toBe(true);
  });

  // The module's own width beats anything the drawing step works out.
  it('draws a generated panel at the width recorded on the module', async () => {
    const { module } = await analyzedModule(db, manualsDir, { hp: 16 });
    const { panel } = await buildPanelForModule(
      db,
      fakeBackend({
        completeTextWithSearch: JSON.stringify({ image_urls: [], hp: 4 }),
        analyzeDocument: JSON.stringify({ hp: 6, components: [{ name: 'FREQ', x: 0.5, y: 0.2 }] }),
      }),
      module,
      panelsDir,
      { fetchImpl: fakeFetch({}), manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`) }
    );
    expect(panel.hp).toBe(16);
  });

  // ...and where the module has no width, the one the panel step found fills
  // the column in (migration 017).
  it('records a width on the module when it had none', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    await buildPanelForModule(
      db,
      fakeBackend({
        completeTextWithSearch: JSON.stringify({ image_urls: [] }),
        analyzeDocument: JSON.stringify({ hp: 6, components: [{ name: 'FREQ', x: 0.5, y: 0.2 }] }),
      }),
      module,
      panelsDir,
      { fetchImpl: fakeFetch({}), manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`) }
    );
    const after = await db.models.Module.findByPk(module.id);
    expect(after.hp).toBe(6);
  });

  // The job spends minutes in LLM calls; an upload arriving in the middle of
  // one must not be thrown away by the answer that comes back afterwards.
  it('keeps a panel uploaded while the job was running', async () => {
    const { module } = await analyzedModule(db, manualsDir);
    const hash = saveImage(panelsDir, PANEL_PNG, 'png');
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({ image_urls: [] }),
      analyzeImage: JSON.stringify({
        is_panel: true,
        components: COMPONENTS.map((c) => ({ name: c.name, x: 0.5, y: 0.5 })),
      }),
      // The upload lands while the manual is being read for a layout.
      analyzeDocument: async () => {
        await db.models.ModulePanel.create({
          module_id: module.id,
          source: 'upload',
          image_hash: hash,
          image_ext: 'png',
          width: 400,
          height: 1200,
        });
        return JSON.stringify({ hp: 8, components: [{ name: 'FREQ', x: 0.5, y: 0.2 }] });
      },
    });
    const { panel } = await buildPanelForModule(db, backend, module, panelsDir, {
      fetchImpl: fakeFetch({}),
      manualFile: path.join(manualsDir, `${PDF_HASH}.pdf`),
    });

    expect(panel.source).toBe('upload');
    expect(panel.image_hash).toBe(hash);
    expect(await db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
    // The drawing that lost the race was never written to disk.
    expect(fs.readdirSync(panelsDir).filter((f) => f.endsWith('.svg'))).toEqual([]);
  });

  it('refuses to build a panel for a module with no analyzed components', async () => {
    const user = await createUser(db, { username: 'nobody' });
    const module = await insertModule(db, user.id, { name: 'Unanalyzed' });
    await expect(
      buildPanelForModule(db, fakeBackend(), module, panelsDir, { fetchImpl: fakeFetch({}) })
    ).rejects.toThrow(/no analyzed components/);
  });
});

describe('the panel_image job', () => {
  let db;
  let manualsDir;
  let panelsDir;

  beforeEach(async () => {
    db = await createTestDb();
    manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-job-manuals-'));
    panelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-job-images-'));
  });
  afterEach(() => {
    fs.rmSync(manualsDir, { recursive: true, force: true });
    fs.rmSync(panelsDir, { recursive: true, force: true });
  });

  const makeWorker = (backend, fetchImpl = fakeFetch({})) =>
    createWorker(db, {
      manualsDir,
      panelsDir,
      backendFactory: () => backend,
      fetchImpl,
      log: () => {},
    });

  it('builds the panel and marks the module complete', async () => {
    const { user, module } = await analyzedModule(db, manualsDir);
    await enqueueJob(db, 'panel_image', { moduleId: module.id, userId: user.id });
    const worker = makeWorker(
      fakeBackend({
        completeTextWithSearch: JSON.stringify({ image_urls: [] }),
        analyzeDocument: JSON.stringify({
          hp: 8,
          components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
        }),
      })
    );
    const done = await worker.tick();

    expect(done.status).toBe('complete');
    const after = await db.models.Module.findByPk(module.id);
    expect(after.panel_status).toBe('complete');
    expect(await db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
  });

  it('marks the module failed when the panel cannot be built', async () => {
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { name: 'Unanalyzed' });
    await enqueueJob(db, 'panel_image', { moduleId: module.id, userId: user.id });
    const worker = makeWorker(fakeBackend());
    await worker.tick();

    const after = await db.models.Module.findByPk(module.id);
    expect(after.panel_status).toBe('failed');
  });

  // The panel needs the component list the analysis writes, so it is chained
  // behind it rather than queued alongside.
  it('is queued by a successful analysis', async () => {
    const { user, module } = await analyzedModule(db, manualsDir, {
      analysis_status: 'pending',
    });
    await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
    const worker = makeWorker(
      fakeBackend({
        analyzeDocument: JSON.stringify({
          summary: 'A VCO.',
          components: COMPONENTS.map((c) => ({ ...c, description: null })),
        }),
      })
    );
    await worker.tick();

    const queued = await db.models.Job.findAll({ where: { type: 'panel_image' } });
    expect(queued).toHaveLength(1);
    expect(queued[0].module_id).toBe(module.id);
  });
});

describe('panel image route', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await createTestApp();
  });

  async function storePanel(moduleId, bytes = PANEL_PNG, ext = 'png') {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(panelPath(ctx.panelsDir, hash, ext), bytes);
    await ctx.db.models.ModulePanel.create({
      module_id: moduleId,
      source: 'image',
      image_hash: hash,
      image_ext: ext,
      width: 400,
      height: 1200,
    });
    return hash;
  }

  it('serves a panel image referenced by a module', async () => {
    const alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(ctx.db, alice.id);
    const hash = await storePanel(module.id);
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('404s on a hash no panel references, and on a bad name', async () => {
    const stranger = 'a'.repeat(64);
    fs.writeFileSync(panelPath(ctx.panelsDir, stranger, 'png'), PANEL_PNG);
    expect(
      (await request(ctx.app).get(`/api/panels/${stranger}.png`).set('Cookie', ctx.aliceCookie))
        .status
    ).toBe(404);
    expect(
      (await request(ctx.app).get('/api/panels/..%2Fmanuals.pdf').set('Cookie', ctx.aliceCookie))
        .status
    ).toBe(404);
  });

  it('requires a session', async () => {
    const alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(ctx.db, alice.id);
    const hash = await storePanel(module.id);
    expect((await request(ctx.app).get(`/api/panels/${hash}.png`)).status).toBe(401);
  });

  it('carries the panel into the module detail and the patch', async () => {
    const alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(ctx.db, alice.id);
    const component = await ctx.db.models.ModuleComponent.create({
      module_id: module.id,
      type: 'output_jack',
      name: 'OUT',
      description: 'The main output.',
    });
    const hash = await storePanel(module.id);
    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    const marker = await ctx.db.models.ModulePanelComponent.create({
      panel_id: panel.id,
      component_id: component.id,
      name: 'OUT',
      shape: 'jack',
      x: 0.5,
      y: 0.9,
      w: 0.06,
      h: 0.06,
    });

    const detail = await request(ctx.app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', ctx.aliceCookie);
    expect(detail.body.panel).toMatchObject({
      source: 'image',
      url: `/api/panels/${hash}.png`,
      width: 400,
      height: 1200,
    });
    // The marker carries its own id, so it can be corrected by hand, and what
    // the manual says the component does, so resting on it says something.
    expect(detail.body.panel.components).toEqual([
      {
        id: marker.id,
        component_id: component.id,
        name: 'OUT',
        shape: 'jack',
        description: 'The main output.',
        x: 0.5,
        y: 0.9,
        w: 0.06,
        h: 0.06,
      },
    ]);

    const rack = await ctx.db.models.Rack.findOne({ where: { user_id: alice.id } });
    const created = await request(ctx.app)
      .post('/api/patches')
      .set('Cookie', ctx.aliceCookie)
      .send({ rack_id: rack.id, name: 'Diagram' });
    const patch = await request(ctx.app)
      .get(`/api/patches/${created.body.id}`)
      .set('Cookie', ctx.aliceCookie);
    expect(patch.body.modules[0].panel.url).toBe(`/api/panels/${hash}.png`);
  });
});

describe('filling in what modules are missing', () => {
  let ctx;
  let alice;
  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
  });

  const reanalyze = (body = {}) =>
    request(ctx.app).post('/api/modules/reanalyze').set('Cookie', ctx.aliceCookie).send(body);

  // A module the pipeline finished with: manual, analysis (components and a
  // summary), a panel picture and a width.
  async function completeModule(fields = {}) {
    const module = await insertModule(ctx.db, alice.id, {
      manual_hash: PDF_HASH,
      // A finished module has had its manual extracted to markdown too.
      manual_text: '# Manual\n\nA function generator with four channels.\n',
      analysis_status: 'complete',
      panel_status: 'complete',
      summary: 'A function generator.',
      hp: 20,
      ...fields,
    });
    await ctx.db.models.ModuleComponent.create({
      module_id: module.id,
      name: 'OUT',
      type: 'output_jack',
      description: 'The main output.',
    });
    await ctx.db.models.ModulePanel.create({
      module_id: module.id,
      source: 'generated',
      image_hash: `panel-${module.id}`,
      image_ext: 'svg',
      width: 400,
      height: 1200,
      hp: 20,
    });
    return module;
  }

  it('queues the earliest missing step for each module, and nothing for the complete ones', async () => {
    const done = await completeModule({ name: 'Maths' });
    const noManual = await insertModule(ctx.db, alice.id, { name: 'Rene' });
    const noAnalysis = await insertModule(ctx.db, alice.id, {
      name: 'Wogglebug',
      manual_hash: PDF_HASH,
    });
    const noPanel = await completeModule({ name: 'Optomix' });
    await ctx.db.models.ModulePanel.destroy({ where: { module_id: noPanel.id } });

    const res = await reanalyze();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      modules: 4,
      queued: {
        find_manual: 1,
        analyze_manual: 1,
        panel_image: 1,
        extract_manual: 1,
        describe_components: 0,
      },
      skipped: 0,
      complete: 1,
    });

    const jobs = await ctx.db.models.Job.findAll({ order: [['id', 'ASC']] });
    expect(jobs.map((j) => [j.type, j.module_id, j.user_id])).toEqual([
      // A manual nobody has extracted text from yet, which is its own gap
      // rather than a step of the pipeline.
      ['extract_manual', noAnalysis.id, alice.id],
      // Nothing to analyze without a manual, so it goes to find one.
      ['find_manual', noManual.id, alice.id],
      ['analyze_manual', noAnalysis.id, alice.id],
      ['panel_image', noPanel.id, alice.id],
    ]);
    // The finished module was not touched at all.
    const after = await ctx.db.models.Module.findByPk(done.id);
    expect(after.analysis_status).toBe('complete');
    expect(after.panel_status).toBe('complete');
    expect((await ctx.db.models.Module.findByPk(noAnalysis.id)).analysis_status).toBe('pending');
    expect((await ctx.db.models.Module.findByPk(noPanel.id)).panel_status).toBe('pending');
  });

  it('counts an analysis that produced no components as missing', async () => {
    const module = await completeModule();
    await ctx.db.models.ModuleComponent.destroy({ where: { module_id: module.id } });
    const res = await reanalyze();
    expect(res.body.queued.analyze_manual).toBe(1);
    // Re-discovery is off by default: the manual it already has stands.
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.manual_status).toBe('found');
    expect(after.analysis_status).toBe('pending');
  });

  it('fills a missing HP from the documents rather than rebuilding the panel', async () => {
    const module = await completeModule();
    await ctx.db.models.Module.update({ hp: null }, { where: { id: module.id } });
    const res = await reanalyze();
    // The panel job would replace the picture and rebuild every marker; a
    // module that only lacks its width gets the narrow pass instead.
    expect(res.body.queued).toEqual({
      find_manual: 0,
      analyze_manual: 0,
      panel_image: 0,
      extract_manual: 0,
      describe_components: 1,
    });
    const jobs = await ctx.db.models.Job.findAll({ where: { type: 'describe_components' } });
    expect(jobs.map((j) => j.module_id)).toEqual([module.id]);
  });

  it('fills a missing summary without destroying the components', async () => {
    const module = await completeModule();
    await ctx.db.models.Module.update({ summary: null }, { where: { id: module.id } });
    const res = await reanalyze();
    // A full analysis would wipe and rebuild the component inventory; a
    // module that has components keeps them, whatever else it is missing.
    expect(res.body.queued).toMatchObject({ analyze_manual: 0, describe_components: 1 });
    expect((await ctx.db.models.Module.findByPk(module.id)).analysis_status).toBe('complete');
  });

  // How panels are built changes; the modules do not. Nothing about a
  // complete module says its markers were placed by older code, so redoing
  // them has to be something you can just ask for.
  it('sends every analyzed module back to the panel step when asked to rebuild', async () => {
    const done = await completeModule({ name: 'Maths' });
    const alsoDone = await completeModule({ name: 'Optomix' });
    const noManual = await insertModule(ctx.db, alice.id, { name: 'Rene' });

    const res = await reanalyze({ rebuild_panels: true });
    expect(res.status).toBe(200);
    expect(res.body.queued).toMatchObject({ panel_image: 2, find_manual: 1 });

    const panelJobs = await ctx.db.models.Job.findAll({ where: { type: 'panel_image' } });
    expect(panelJobs.map((j) => j.module_id).sort()).toEqual([done.id, alsoDone.id].sort());
    // A module with no manual has no components to place, so it goes back to
    // the start of the pipeline rather than to the panel step.
    expect(panelJobs.map((j) => j.module_id)).not.toContain(noManual.id);
    expect((await ctx.db.models.Module.findByPk(done.id)).panel_status).toBe('pending');
  });

  it('leaves complete panels alone without the flag', async () => {
    await completeModule({ name: 'Maths' });
    const res = await reanalyze();
    expect(res.body.queued.panel_image).toBe(0);
    expect(res.body.complete).toBe(1);
  });

  it('re-discovers the manual of an unanalyzed module when asked to', async () => {
    const module = await completeModule();
    await ctx.db.models.ModuleComponent.destroy({ where: { module_id: module.id } });
    const res = await reanalyze({ rediscover_manuals: true });
    expect(res.body.queued).toEqual({
      find_manual: 1,
      analyze_manual: 0,
      panel_image: 0,
      extract_manual: 0,
      describe_components: 0,
    });
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.manual_status).toBe('pending');
    expect(after.analysis_status).toBe('pending');
  });

  it('leaves a complete module alone even with re-discovery on', async () => {
    await completeModule();
    const res = await reanalyze({ rediscover_manuals: true });
    expect(res.body).toMatchObject({ modules: 1, complete: 1, skipped: 0 });
    expect(await ctx.db.models.Job.count()).toBe(0);
  });

  it('does not queue the same work twice', async () => {
    await insertModule(ctx.db, alice.id, { manual_hash: PDF_HASH });
    await reanalyze();
    const second = await reanalyze();
    expect(second.body).toEqual({
      modules: 1,
      queued: {
        find_manual: 0,
        analyze_manual: 0,
        panel_image: 0,
        extract_manual: 0,
        describe_components: 0,
      },
      skipped: 1,
      complete: 0,
    });
    // The analysis and the text extraction of the one manual, queued once.
    expect(await ctx.db.models.Job.count()).toBe(2);
  });

  it('narrows to one rack, and only ever to your own', async () => {
    await insertModule(ctx.db, alice.id, { name: 'Maths', manual_hash: PDF_HASH });
    await insertModule(ctx.db, alice.id, {
      name: 'Rene',
      rack: 'travel case',
      manual_hash: PDF_HASH,
    });
    const travel = await ctx.db.models.Rack.findOne({
      where: { user_id: alice.id, name: 'travel case' },
    });
    const res = await reanalyze({ rack_id: travel.id });
    expect(res.body.modules).toBe(1);

    const admin = await ctx.db.models.User.findOne({ where: { username: 'admin' } });
    await insertModule(ctx.db, admin.id, { name: 'Wogglebug' });
    const adminRack = await ctx.db.models.Rack.findOne({ where: { user_id: admin.id } });
    expect((await reanalyze({ rack_id: adminRack.id })).status).toBe(404);
  });

  it('leaves another user\'s modules alone', async () => {
    const admin = await ctx.db.models.User.findOne({ where: { username: 'admin' } });
    await insertModule(ctx.db, admin.id, { name: 'Wogglebug', manual_hash: PDF_HASH });
    const res = await reanalyze();
    expect(res.body.modules).toBe(0);
    expect(await ctx.db.models.Job.count()).toBe(0);
  });

  it('requires a session', async () => {
    expect((await request(ctx.app).post('/api/modules/reanalyze').send({})).status).toBe(401);
  });

  it('finds a manual for a hand-built module without marking it for analysis', async () => {
    // A module built entirely by hand: components exist, no manual ever did.
    const module = await insertModule(ctx.db, alice.id, { name: 'DIY Mixer' });
    await ctx.db.models.ModuleComponent.create({
      module_id: module.id,
      name: 'IN 1',
      type: 'input_jack',
      description: 'First channel in.',
    });
    const before = (await ctx.db.models.Module.findByPk(module.id)).analysis_status;

    const res = await reanalyze();
    expect(res.body.queued).toMatchObject({ find_manual: 1, analyze_manual: 0 });
    // No analysis is coming for it (the find job chains the narrow pass
    // instead), so its analysis status is left exactly as it was.
    expect((await ctx.db.models.Module.findByPk(module.id)).analysis_status).toBe(before);
  });

  it('queues a description pass for hand-added components with none', async () => {
    // Otherwise complete, but with a hand-added jack the analysis never saw.
    const done = await completeModule({ name: 'Maths' });
    await ctx.db.models.ModuleComponent.create({
      module_id: done.id,
      name: 'Both',
      type: 'output_jack',
    });
    // Missing its panel AND a description: the panel job does not write
    // descriptions, so both jobs go out.
    const noPanel = await completeModule({ name: 'Optomix' });
    await ctx.db.models.ModulePanel.destroy({ where: { module_id: noPanel.id } });
    await ctx.db.models.ModuleComponent.create({
      module_id: noPanel.id,
      name: 'CTRL',
      type: 'input_jack',
      description: '   ',
    });
    // Missing its analysis: the analysis rewrites every component anyway, so
    // no separate description pass is queued behind it.
    const noAnalysis = await insertModule(ctx.db, alice.id, {
      name: 'Wogglebug',
      manual_hash: PDF_HASH,
      manual_text: '# Manual\n',
    });
    await ctx.db.models.ModuleComponent.destroy({ where: { module_id: noAnalysis.id } });

    const res = await reanalyze();
    expect(res.status).toBe(200);
    expect(res.body.queued).toMatchObject({
      describe_components: 2,
      panel_image: 1,
      analyze_manual: 1,
    });
    expect(res.body.complete).toBe(0);
    const jobs = await ctx.db.models.Job.findAll({ where: { type: 'describe_components' } });
    expect(jobs.map((j) => j.module_id).sort()).toEqual([done.id, noPanel.id].sort());
    // The statuses the pipeline walks are not touched by the narrow pass.
    expect((await ctx.db.models.Module.findByPk(done.id)).analysis_status).toBe('complete');

    // Asking again queues nothing new: the pass is already waiting.
    const second = await reanalyze();
    expect(second.body.queued.describe_components).toBe(0);
    expect(second.body.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('uploading your own panel image', () => {
  let ctx;
  let alice;
  let panelFetch;
  beforeEach(async () => {
    panelFetch = fakeFetch({
      'cdn.example.com/a110-front.png': { body: PANEL_PNG },
      'cdn.example.com/not-an-image.png': { body: PDF_BYTES },
    });
    ctx = await createTestApp({ fetchImpl: panelFetch });
    alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
  });

  const upload = (moduleId, body, cookie = ctx.aliceCookie) =>
    request(ctx.app).post(`/api/modules/${moduleId}/panel`).set('Cookie', cookie).send(body);

  // A module in alice's rack with components to place, which is what the
  // queued job needs to have anything to do.
  async function moduleWithComponents() {
    const module = await insertModule(ctx.db, alice.id, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      analysis_status: 'complete',
    });
    await ctx.db.models.ModuleComponent.bulkCreate(
      COMPONENTS.map((c) => ({ ...c, module_id: module.id }))
    );
    return module;
  }

  it('stores the image, records the width, and queues the job that maps it', async () => {
    const module = await moduleWithComponents();
    const res = await upload(module.id, {
      filename: 'a110-front.png',
      data_base64: PANEL_PNG.toString('base64'),
      hp: 8,
    });

    expect(res.status).toBe(201);
    expect(res.body.panel.source).toBe('upload');
    expect(res.body.panel.width).toBe(400);
    expect(res.body.panel.height).toBe(1200);
    expect(res.body.panel.hp).toBe(8);
    // Nothing is placed yet: where a component sits on a picture the server
    // has never seen is the queued job's work.
    expect(res.body.panel.components).toEqual([]);
    expect(res.body.job_id).toBeGreaterThan(0);

    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(fs.existsSync(panelPath(ctx.panelsDir, panel.image_hash, 'png'))).toBe(true);
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.hp).toBe(8);

    const job = await ctx.db.models.Job.findByPk(res.body.job_id);
    expect(job.type).toBe('panel_image');
    expect(job.module_id).toBe(module.id);
    expect(job.user_id).toBe(alice.id);
  });

  it('trims a blank surround as soon as the panel is uploaded', async () => {
    const module = await moduleWithComponents();
    const sharp = await loadSharp();
    const bordered = await sharp({
      create: {
        width: 160,
        height: 400,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 96,
              height: 300,
              channels: 3,
              background: '#222222',
            },
          },
          left: 32,
          top: 50,
        },
      ])
      .png()
      .toBuffer();

    const res = await upload(module.id, {
      filename: 'panel-with-border.png',
      data_base64: bordered.toString('base64'),
      hp: 8,
    });

    expect(res.status).toBe(201);
    expect(res.body.panel.width).toBe(160);
    expect(res.body.panel.height).toBe(400);
    expect(res.body.panel.crop.x).toBeCloseTo(32 / 160);
    expect(res.body.panel.crop.y).toBeCloseTo(50 / 400);
    expect(res.body.panel.crop.w).toBeCloseTo(96 / 160);
    expect(res.body.panel.crop.h).toBeCloseTo(300 / 400);
  });

  it('downloads a panel from a URL and treats it like a user-supplied image', async () => {
    const module = await moduleWithComponents();
    const url = 'https://cdn.example.com/a110-front.png';
    const res = await upload(module.id, { url, hp: 8 });

    expect(res.status).toBe(201);
    expect(res.body.panel.source).toBe('upload');
    expect(res.body.panel.source_url).toBe(url);
    expect(res.body.panel.width).toBe(400);
    expect(res.body.panel.height).toBe(1200);
    expect(res.body.panel.hp).toBe(8);
    expect(res.body.job_id).toBeGreaterThan(0);
    expect(panelFetch.requested).toEqual([url]);

    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(fs.existsSync(panelPath(ctx.panelsDir, panel.image_hash, 'png'))).toBe(true);
  });

  // The whole point of the upload: the components end up on the user's own
  // picture, at the positions the LLM reads off it.
  it('maps the components onto the uploaded image when the job runs', async () => {
    const module = await moduleWithComponents();
    await upload(module.id, {
      filename: 'a110.png',
      data_base64: PANEL_PNG.toString('base64'),
    });
    const uploaded = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({ image_urls: ['https://example.com/other.png'] }),
      analyzeImage: JSON.stringify({
        is_panel: true,
        panel: { x: 0.5, y: 0.5, w: 0.8, h: 1 },
        components: COMPONENTS.map((c, i) => ({ name: c.name, x: 0.5, y: 0.15 * (i + 1) })),
      }),
    });
    const worker = createWorker(ctx.db, {
      manualsDir: ctx.manualsDir,
      panelsDir: ctx.panelsDir,
      backendFactory: () => backend,
      fetchImpl: fakeFetch({}),
      log: () => {},
    });
    const done = await worker.tick();
    expect(done.status).toBe('complete');

    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    // Same picture, now with markers on it.
    expect(panel.source).toBe('upload');
    expect(panel.image_hash).toBe(uploaded.image_hash);
    expect(panel.crop_w).toBeCloseTo(0.8);
    expect(await ctx.db.models.ModulePanelComponent.count({ where: { panel_id: panel.id } })).toBe(5);
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.panel_status).toBe('complete');
  });

  it('replaces the panel that was there and drops its orphaned image', async () => {
    const module = await moduleWithComponents();
    const stale = saveImage(ctx.panelsDir, pngBytes(300, 900), 'png');
    await ctx.db.models.ModulePanel.create({
      module_id: module.id,
      source: 'image',
      image_hash: stale,
      image_ext: 'png',
      width: 300,
      height: 900,
    });

    await upload(module.id, { filename: 'mine.png', data_base64: PANEL_PNG.toString('base64') });

    expect(await ctx.db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
    expect(fs.existsSync(panelPath(ctx.panelsDir, stale, 'png'))).toBe(false);
  });

  it('refuses anything that is not an image it serves', async () => {
    const module = await moduleWithComponents();
    const pdf = await upload(module.id, {
      filename: 'panel.png',
      data_base64: PDF_BYTES.toString('base64'),
    });
    expect(pdf.status).toBe(400);
    expect(pdf.body.error).toMatch(/PNG, JPEG, GIF or WebP/);

    // An SVG is a document that can carry script; it is not hosted here even
    // when a user hands it over deliberately.
    const svg = await upload(module.id, {
      filename: 'panel.svg',
      data_base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="300"></svg>'
      ).toString('base64'),
    });
    expect(svg.status).toBe(400);

    const tiny = await upload(module.id, {
      filename: 'tiny.png',
      data_base64: pngBytes(16, 16).toString('base64'),
    });
    expect(tiny.status).toBe(400);
    expect(tiny.body.error).toMatch(/too small/);

    expect((await upload(module.id, { filename: 'p.png' })).status).toBe(400);
    expect(
      (await upload(module.id, {
        filename: 'p.png',
        data_base64: PANEL_PNG.toString('base64'),
        hp: 'wide',
      })).status
    ).toBe(400);
    expect(await ctx.db.models.ModulePanel.count()).toBe(0);
  });

  it('rejects invalid panel URLs and ambiguous upload sources', async () => {
    const module = await moduleWithComponents();
    expect((await upload(module.id, { url: 'file:///tmp/panel.png' })).status).toBe(400);
    expect(
      (await upload(module.id, { url: 'https://cdn.example.com/not-an-image.png' })).status
    ).toBe(400);
    expect(
      (await upload(module.id, {
        url: 'https://cdn.example.com/a110-front.png',
        filename: 'also-uploaded.png',
        data_base64: PANEL_PNG.toString('base64'),
      })).status
    ).toBe(400);
    expect(await ctx.db.models.ModulePanel.count()).toBe(0);
  });

  it('only accepts an upload for a module in your own racks', async () => {
    const admin = await ctx.db.models.User.findOne({ where: { username: 'admin' } });
    const theirs = await insertModule(ctx.db, admin.id, { name: 'Wogglebug' });
    const res = await upload(theirs.id, {
      filename: 'p.png',
      data_base64: PANEL_PNG.toString('base64'),
    });
    expect(res.status).toBe(404);
    expect(
      (await request(ctx.app).post(`/api/modules/${theirs.id}/panel`).send({})).status
    ).toBe(401);
  });

  it('analyzes an existing manual before mapping an imported panel with no components', async () => {
    const module = await insertModule(ctx.db, alice.id, {
      name: 'Unanalyzed',
      manual_hash: PDF_HASH,
      analysis_status: 'pending',
    });
    fs.writeFileSync(path.join(ctx.manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const res = await upload(module.id, {
      filename: 'p.png',
      data_base64: PANEL_PNG.toString('base64'),
    });
    expect(res.status).toBe(201);
    const analysisJob = await ctx.db.models.Job.findByPk(res.body.job_id);
    expect(analysisJob.type).toBe('analyze_manual');

    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A VCO.',
        components: COMPONENTS.map((c) => ({ ...c, description: null })),
      }),
      analyzeImage: JSON.stringify({
        is_panel: true,
        panel: { x: 0, y: 0, w: 1, h: 1 },
        components: COMPONENTS.map((c, i) => ({
          name: c.name,
          x: 0.5,
          y: 0.15 * (i + 1),
        })),
      }),
    });
    const worker = createWorker(ctx.db, {
      manualsDir: ctx.manualsDir,
      panelsDir: ctx.panelsDir,
      backendFactory: () => backend,
      fetchImpl: fakeFetch({}),
      log: () => {},
    });

    expect((await worker.tick()).type).toBe('analyze_manual');
    expect((await worker.tick()).type).toBe('panel_image');
    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(panel.source).toBe('upload');
    expect(
      await ctx.db.models.ModulePanelComponent.count({ where: { panel_id: panel.id } })
    ).toBe(COMPONENTS.length);
  });

  it('starts manual discovery when an imported panel has no components or manual', async () => {
    const module = await insertModule(ctx.db, alice.id, { name: 'Unknown' });
    const res = await upload(module.id, {
      url: 'https://cdn.example.com/a110-front.png',
    });
    expect(res.status).toBe(201);
    const job = await ctx.db.models.Job.findByPk(res.body.job_id);
    expect(job.type).toBe('find_manual');
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.manual_status).toBe('pending');
    expect(after.analysis_status).toBe('pending');
  });

  it('removes an uploaded panel and queues a replacement', async () => {
    const module = await moduleWithComponents();
    await upload(module.id, { filename: 'p.png', data_base64: PANEL_PNG.toString('base64') });
    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    await ctx.db.models.Job.destroy({ where: {} });

    const res = await request(ctx.app)
      .delete(`/api/modules/${module.id}/panel`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.job_id).toBeGreaterThan(0);
    expect(await ctx.db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(0);
    expect(fs.existsSync(panelPath(ctx.panelsDir, panel.image_hash, 'png'))).toBe(false);
    const after = await ctx.db.models.Module.findByPk(module.id);
    expect(after.panel_status).toBe('pending');
  });

  // Dragging a marker onto the hardware it names. Everything that put it
  // where it was is an estimate; this is the person looking at the picture
  // saying where it really is.
  describe('correcting a marker by hand', () => {
    async function panelWithMarker() {
      const module = await moduleWithComponents();
      const panel = await ctx.db.models.ModulePanel.create({
        module_id: module.id,
        source: 'image',
        image_hash: 'c'.repeat(64),
        image_ext: 'png',
        width: 400,
        height: 1200,
        crop_x: 0.1,
        crop_y: 0,
        crop_w: 0.8,
        crop_h: 1,
      });
      const component = await ctx.db.models.ModuleComponent.findOne({
        where: { module_id: module.id, name: '1V/OCT' },
      });
      const marker = await ctx.db.models.ModulePanelComponent.create({
        panel_id: panel.id,
        component_id: component.id,
        name: '1V/OCT',
        shape: 'jack',
        x: 0.5,
        y: 0.9,
      });
      return { module, marker };
    }

    const move = (moduleId, markerId, body, cookie = ctx.aliceCookie) =>
      request(ctx.app)
        .patch(`/api/modules/${moduleId}/panel/components/${markerId}`)
        .set('Cookie', cookie)
        .send(body);

    it('saves the marker where it was dropped and returns the panel', async () => {
      const { module, marker } = await panelWithMarker();
      const res = await move(module.id, marker.id, { x: 0.42, y: 0.63 });

      expect(res.status).toBe(200);
      const placed = res.body.panel.components.find((c) => c.id === marker.id);
      expect(placed.x).toBeCloseTo(0.42);
      expect(placed.y).toBeCloseTo(0.63);
      await marker.reload();
      expect(marker.x).toBeCloseTo(0.42);
      expect(marker.y).toBeCloseTo(0.63);
    });

    it('refuses a position that is not on the image', async () => {
      const { module, marker } = await panelWithMarker();
      for (const body of [{ x: 1.4, y: 0.5 }, { x: 0.5, y: -0.2 }, { x: 'left', y: 0.5 }, {}]) {
        expect((await move(module.id, marker.id, body)).status).toBe(400);
      }
      await marker.reload();
      expect(marker.y).toBeCloseTo(0.9);
    });

    it('will not move a marker on a module that is not in your racks', async () => {
      const { module, marker } = await panelWithMarker();
      await createUser(ctx.db, { username: 'bob' });
      const bob = await login(ctx.app, 'bob');
      const res = await move(module.id, marker.id, { x: 0.4, y: 0.4 }, bob);
      expect(res.status).toBe(404);
      await marker.reload();
      expect(marker.y).toBeCloseTo(0.9);
    });

    it('will not move a marker that belongs to another module\'s panel', async () => {
      const { marker } = await panelWithMarker();
      const other = await insertModule(ctx.db, alice.id, { manufacturer: 'Doepfer', name: 'A-118' });
      const res = await move(other.id, marker.id, { x: 0.4, y: 0.4 });
      expect(res.status).toBe(404);
      await marker.reload();
      expect(marker.y).toBeCloseTo(0.9);
    });
  });

  it('will not delete a panel the app built itself', async () => {
    const module = await moduleWithComponents();
    await ctx.db.models.ModulePanel.create({
      module_id: module.id,
      source: 'generated',
      image_hash: 'b'.repeat(64),
      image_ext: 'svg',
      width: 325,
      height: 1028,
    });
    const res = await request(ctx.app)
      .delete(`/api/modules/${module.id}/panel`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(404);
    expect(await ctx.db.models.ModulePanel.count({ where: { module_id: module.id } })).toBe(1);
  });
});

describe('trimming a panel picture', () => {
  let ctx;
  let alice;
  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
  });

  // A drawn 2HP plate on a large blank backdrop, stored as the module's
  // panel with no crop — the state Trim exists to fix.
  async function paddedPanel({ blank = false, name = 'Maths' } = {}) {
    const sharp = await loadSharp();
    const pxPerMm = 4;
    const plateW = Math.round(2 * HP_MM * pxPerMm);
    const plateH = Math.round(PANEL_MM_HEIGHT * pxPerMm);
    const padX = 160;
    const padY = 60;
    const width = plateW + padX * 2;
    const height = plateH + padY * 2;
    const gray = Buffer.alloc(width * height, 250);
    if (!blank) {
      for (let y = padY; y < padY + plateH; y++) {
        for (let x = padX; x < padX + plateW; x++) gray[y * width + x] = 120;
      }
      // Hardware on the plate: a flat rectangle is uniform enough to read as
      // backdrop itself, and a real panel never is.
      for (let i = 1; i <= 3; i++) {
        const cy = padY + Math.round((plateH * i) / 4);
        const cx = padX + Math.round(plateW / 2);
        for (let y = cy - 6; y <= cy + 6; y++) {
          for (let x = cx - 6; x <= cx + 6; x++) gray[y * width + x] = 20;
        }
      }
    }
    const png = await sharp(gray, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
    const module = await insertModule(ctx.db, alice.id, { name, hp: 2 });
    const hash = saveImage(ctx.panelsDir, png, 'png');
    const panel = await ctx.db.models.ModulePanel.create({
      module_id: module.id,
      source: 'image',
      image_hash: hash,
      image_ext: 'png',
      width,
      height,
      hp: 2,
      crop_x: 0,
      crop_y: 0,
      crop_w: 1,
      crop_h: 1,
    });
    return { module, panel, width, height, padX, padY, plateW, plateH };
  }

  const trim = (moduleId) =>
    request(ctx.app).post(`/api/modules/${moduleId}/panel/trim`).set('Cookie', ctx.aliceCookie);

  it('cuts the plate out of the file and re-bases every marker onto it', async () => {
    const { module, width, height, padX, padY, plateW, plateH } = await paddedPanel();
    const { rows: jack } = await ctx.db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'OUT')
       RETURNING id`,
      [module.id]
    );
    // A marker sitting at the exact center of the plate, as whole-image
    // fractions — the way every placement is stored.
    const markerX = (padX + plateW / 2) / width;
    const markerY = (padY + plateH / 2) / height;
    const dbPanel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    const before = { hash: dbPanel.image_hash, ext: dbPanel.image_ext };
    await ctx.db.models.ModulePanelComponent.create({
      panel_id: dbPanel.id,
      component_id: jack[0].id,
      name: 'OUT',
      shape: 'jack',
      x: markerX,
      y: markerY,
      w: 0.06,
      h: 0.06,
    });

    const res = await trim(module.id);
    expect(res.status).toBe(200);
    // The picture itself is now the plate: new bytes, plate-sized, and
    // nothing left to crop away.
    expect(res.body.panel.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(res.body.panel.width).toBeCloseTo(plateW, -1);
    expect(res.body.panel.height).toBeCloseTo(plateH, -1);
    const after = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(after.image_hash).not.toBe(before.hash);
    expect(fs.existsSync(panelPath(ctx.panelsDir, after.image_hash, after.image_ext))).toBe(true);
    // The bytes nothing points at any more are gone.
    expect(fs.existsSync(panelPath(ctx.panelsDir, before.hash, before.ext))).toBe(false);
    // The marker was the center of the plate and still is — measured against
    // the smaller picture it now sits on.
    const marker = res.body.panel.components[0];
    expect(marker.x).toBeCloseTo(0.5, 1);
    expect(marker.y).toBeCloseTo(0.5, 1);
    // A marker's own size grew with everything else in the picture.
    expect(marker.w).toBeGreaterThan(0.06);

    // Trimming again finds nothing left to take off, so the picture stands.
    const again = await trim(module.id);
    expect(again.status).toBe(200);
    const settled = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(settled.width).toBe(after.width);
    expect(settled.height).toBe(after.height);
    expect(again.body.panel.components[0].x).toBeCloseTo(0.5, 1);
  });

  it('trims every panel in a system from one queued job', async () => {
    const first = await paddedPanel({ name: 'Maths' });
    const second = await paddedPanel({ name: 'Wogglebug' });
    // A module with no panel at all rides along and is simply skipped.
    await insertModule(ctx.db, alice.id, { name: 'Rene' });
    const racks = (await request(ctx.app).get('/api/racks').set('Cookie', ctx.aliceCookie)).body;
    const system = (
      await request(ctx.app)
        .post('/api/systems')
        .set('Cookie', ctx.aliceCookie)
        .send({ name: 'studio' })
    ).body;
    for (const rack of racks) {
      await request(ctx.app)
        .put(`/api/racks/${rack.id}/system`)
        .set('Cookie', ctx.aliceCookie)
        .send({ system_id: system.id });
    }

    const queued = await request(ctx.app)
      .post(`/api/systems/${system.id}/panels/trim`)
      .set('Cookie', ctx.aliceCookie);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ type: 'trim_panels', status: 'pending', reused: false });
    // Asking twice while it is still queued re-uses the sweep already waiting.
    const again = await request(ctx.app)
      .post(`/api/systems/${system.id}/panels/trim`)
      .set('Cookie', ctx.aliceCookie);
    expect(again.body).toMatchObject({ id: queued.body.id, reused: true });
    expect(await ctx.db.models.Job.count({ where: { type: 'trim_panels' } })).toBe(1);

    // Trimming is pixels and file writes: the model is never asked anything.
    const backend = fakeBackend();
    const worker = createWorker(ctx.db, {
      manualsDir: ctx.manualsDir,
      panelsDir: ctx.panelsDir,
      backendFactory: () => backend,
      log: () => {},
    });
    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(Object.values(backend.calls).every((made) => made.length === 0)).toBe(true);

    for (const { module, panel } of [first, second]) {
      const after = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
      expect(after.trimmed).toBe(true);
      expect(after.width).toBeLessThan(panel.width);
      expect(after.crop_w).toBeCloseTo(1);
      expect(fs.existsSync(panelPath(ctx.panelsDir, after.image_hash, after.image_ext))).toBe(true);
    }
  });

  it('will not sweep a system that is not yours', async () => {
    const { module } = await paddedPanel();
    const system = (
      await request(ctx.app)
        .post('/api/systems')
        .set('Cookie', ctx.aliceCookie)
        .send({ name: 'studio' })
    ).body;
    const res = await request(ctx.app)
      .post(`/api/systems/${system.id}/panels/trim`)
      .set('Cookie', ctx.adminCookie);
    expect(res.status).toBe(404);
    expect(await ctx.db.models.Job.count({ where: { type: 'trim_panels' } })).toBe(0);
    const untouched = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    expect(untouched.trimmed).toBeFalsy();
  });

  // The trim races the panel_image job that is placing markers on the same
  // bytes: each would replace the record the other worked from. The button
  // waits its turn instead.
  it('refuses to trim while a panel_image job is still placing the markers', async () => {
    const { module } = await paddedPanel();
    const job = await ctx.db.models.Job.create({
      type: 'panel_image',
      module_id: module.id,
      status: 'running',
    });
    const busy = await trim(module.id);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/still being placed/);

    await job.update({ status: 'complete' });
    expect((await trim(module.id)).status).toBe(200);
  });

  it('404s without a panel or its image, and refuses a blank picture', async () => {
    const bare = await insertModule(ctx.db, alice.id, { name: 'Rene' });
    expect((await trim(bare.id)).status).toBe(404);

    const { module, panel } = await paddedPanel({ blank: true });
    const res = await trim(module.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no panel edge|Could not find/i);

    fs.rmSync(panelPath(ctx.panelsDir, panel.image_hash, 'png'));
    expect((await trim(module.id)).status).toBe(404);
  });
});
