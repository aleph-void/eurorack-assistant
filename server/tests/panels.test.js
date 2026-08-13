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
import { sniffImage, panelPath, saveImage } from '../src/services/image.js';
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
    });
    const hash = await storePanel(module.id);
    const panel = await ctx.db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    await ctx.db.models.ModulePanelComponent.create({
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
    expect(detail.body.panel.components).toEqual([
      { component_id: component.id, name: 'OUT', shape: 'jack', x: 0.5, y: 0.9, w: 0.06, h: 0.06 },
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
      queued: { find_manual: 1, analyze_manual: 1, panel_image: 1, extract_manual: 1 },
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

  it('sends a module with a panel but no HP back to the panel step', async () => {
    const module = await completeModule();
    await ctx.db.models.Module.update({ hp: null }, { where: { id: module.id } });
    const res = await reanalyze();
    expect(res.body.queued).toEqual({
      find_manual: 0,
      analyze_manual: 0,
      panel_image: 1,
      extract_manual: 0,
    });
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
      queued: { find_manual: 0, analyze_manual: 0, panel_image: 0, extract_manual: 0 },
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
});

describe('uploading your own panel image', () => {
  let ctx;
  let alice;
  beforeEach(async () => {
    ctx = await createTestApp();
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

  it('queues nothing for a module with no components to place', async () => {
    const module = await insertModule(ctx.db, alice.id, { name: 'Unanalyzed' });
    const res = await upload(module.id, {
      filename: 'p.png',
      data_base64: PANEL_PNG.toString('base64'),
    });
    expect(res.status).toBe(201);
    expect(res.body.job_id).toBe(null);
    expect(await ctx.db.models.Job.count()).toBe(0);
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
