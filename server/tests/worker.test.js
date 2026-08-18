import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTestDb,
  createUser,
  insertModule,
  mapModule,
  fakeBackend,
  fakeFetch,
  PDF_BYTES,
  PDF_HASH,
} from './helpers.js';
import {
  attemptTimeoutMs,
  createWorker,
  enqueueJob,
  enqueueExtractManual,
  enqueueFindManual,
  MAX_ATTEMPTS,
} from '../src/jobs/worker.js';
import {
  getImportWorkerCount,
  getQueuePause,
  pauseQueue,
  DEFAULT_IMPORT_WORKERS,
} from '../src/services/config.js';
import { noteQuotaExhaustion, takeQuotaExhaustion } from '../src/services/llm.js';
import { createBus } from '../src/events.js';

let manualsDir;
beforeEach(() => {
  manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-manuals-'));
});
afterEach(() => {
  fs.rmSync(manualsDir, { recursive: true, force: true });
});

// Stands in for pdftotext: the extraction is exercised for real in
// manualText.test.js, and no test should need poppler installed.
const fakeExtract = async (db, manual, module) => {
  const content = `# ${module.manufacturer} ${module.name}\n\nExtracted text.\n`;
  const row = await db.models.ManualDocument.create({
    manual_id: manual.id,
    module_id: module.id,
    user_id: manual.user_id ?? null,
    hash: manual.hash,
    title: `${module.manufacturer} ${module.name}`,
    content,
    pages: 1,
    chars: content.length,
    source: 'pdftotext',
  });
  return row.get({ plain: true });
};

function makeWorker(db, backend, fetchImpl, bus, options = {}) {
  return createWorker(db, {
    manualsDir,
    backendFactory: () => backend,
    fetchImpl: fetchImpl || fakeFetch({}),
    // Tests must never launch a real headless chrome.
    renderImpl: async () => false,
    extractImpl: fakeExtract,
    bus,
    log: () => {},
    ...options,
  });
}

async function enqueue(db, type, fields) {
  const { rows } = await db.query(
    `INSERT INTO jobs (type, user_id, module_id, question_id, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [type, fields.user_id ?? null, fields.module_id ?? null, fields.question_id ?? null]
  );
  return rows[0];
}

describe('worker', () => {
  it('returns null when there is nothing to do', async () => {
    const db = await createTestDb();
    const worker = makeWorker(db, fakeBackend());
    expect(await worker.tick()).toBeNull();
  });

  it('processes an import job: creates modules and queues find_manual jobs', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'text', content: 'Make Noise,Maths\nMutable Instruments,Beads' },
    });

    const worker = makeWorker(db, fakeBackend());
    const done = await worker.tick();
    expect(done.status).toBe('complete');

    const { rows: modules } = await db.query('SELECT * FROM modules ORDER BY manufacturer');
    expect(modules).toHaveLength(2);
    const { rows: mappings } = await db.query(
      'SELECT rm.* FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id WHERE r.user_id = $1',
      [user.id]
    );
    expect(mappings).toHaveLength(2);
    // Without a rack in the payload, modules land in the default rack.
    const { rows: racks } = await db.query('SELECT name FROM racks WHERE user_id = $1', [user.id]);
    expect(racks.map((r) => r.name)).toEqual(['main rack']);

    const { rows: jobs } = await db.query(
      "SELECT * FROM jobs WHERE type = 'find_manual' AND status = 'pending'"
    );
    expect(jobs).toHaveLength(2);
  });

  it('processes a modulargrid import job via fetch', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'modulargrid', url: 'https://modulargrid.net/e/racks/view/999' },
    });
    const html =
      '<html>' +
      JSON.stringify({ rack: { Module: [{ name: 'Maths', Vendor: { name: 'Make Noise' } }] } }) +
      '</html>';
    const worker = makeWorker(db, fakeBackend(), fakeFetch({ 'modulargrid.net': { text: html } }));

    const done = await worker.tick();
    expect(done.status).toBe('complete');
    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    expect(modules[0].name).toBe('Maths');
  });

  it('does not queue duplicate find_manual jobs on re-import', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const worker = makeWorker(db, fakeBackend());

    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'text', content: 'Make Noise,Maths' },
    });
    await worker.tick();

    // Simulate the queued find_manual job being in flight, then re-import.
    await db.query("UPDATE jobs SET status = 'running' WHERE type = 'find_manual'");
    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'text', content: 'Make Noise,Maths' },
    });
    await worker.tick();

    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    const { rows: mappings } = await db.query('SELECT quantity FROM rack_modules');
    expect(mappings[0].quantity).toBe(1);
    const { rows: finds } = await db.query("SELECT * FROM jobs WHERE type = 'find_manual'");
    expect(finds).toHaveLength(1);
  });

  it('publishes per-user progress events on the bus', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'text', content: 'Make Noise,Maths' },
    });

    const bus = createBus();
    const events = [];
    bus.subscribe((e) => events.push(e));

    const worker = makeWorker(db, fakeBackend(), undefined, bus);
    await worker.tick();

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.userId === user.id)).toBe(true);
    expect(events[0].event).toBe('started');
    expect(events.at(-1).event).toBe('completed');
    expect(events.some((e) => e.event === 'progress' && /Make Noise Maths/.test(e.message))).toBe(
      true
    );
  });

  it('labels published job events with their module/question target', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'scoping') RETURNING *`,
      [user.id]
    );
    await enqueue(db, 'scope_question', { question_id: q[0].id, user_id: user.id });
    await enqueue(db, 'analyze_manual', { module_id: module.id, user_id: user.id });

    const bus = createBus();
    const events = [];
    bus.subscribe((e) => events.push(e));
    const worker = makeWorker(db, fakeBackend({ completeText: '[]' }), undefined, bus);
    await worker.tick(); // scope_question
    await worker.tick(); // analyze_manual (fails: no manual — labels still set)

    const questionEvents = events.filter((e) => e.job.question_id === q[0].id);
    expect(questionEvents.length).toBeGreaterThan(0);
    expect(questionEvents.every((e) => e.job.question_prompt === 'How?')).toBe(true);
    const moduleEvents = events.filter((e) => e.job.module_id === module.id);
    expect(moduleEvents.length).toBeGreaterThan(0);
    expect(
      moduleEvents.every(
        (e) => e.job.module_name === 'Maths' && e.job.module_manufacturer === 'Make Noise'
      )
    ).toBe(true);
  });

  it('re-searches on import even when the manual was already found', async () => {
    const db = await createTestDb();
    const u1 = await createUser(db, { username: 'u1' });
    const u2 = await createUser(db, { username: 'u2' });
    // u1 already has the module with a found manual; imports still always
    // re-try retrieval (an unchanged manual dedupes by content hash).
    await insertModule(db, u1.id, { manual_hash: PDF_HASH, manual_status: 'found' });

    await enqueueJob(db, 'import', {
      userId: u2.id,
      payload: { type: 'text', content: 'Make Noise,Maths' },
    });
    const worker = makeWorker(db, fakeBackend());
    await worker.tick();

    // u2 is mapped to the same shared module and a fresh search job is queued.
    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    const { rows: mappings } = await db.query(
      'SELECT r.user_id FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id ORDER BY r.user_id'
    );
    expect(mappings.map((m) => m.user_id)).toEqual([u1.id, u2.id]);
    const { rows: finds } = await db.query("SELECT * FROM jobs WHERE type = 'find_manual'");
    expect(finds).toHaveLength(1);
  });

  it('publishes module job events only to the user who caused the job', async () => {
    const db = await createTestDb();
    const u1 = await createUser(db, { username: 'u1' });
    const u2 = await createUser(db, { username: 'u2' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, u1.id, { manual_hash: PDF_HASH });
    // u2 has the same shared module, but u1 triggered the job.
    await mapModule(db, u2.id, module.id);
    await enqueue(db, 'analyze_manual', { module_id: module.id, user_id: u1.id });

    const bus = createBus();
    const events = [];
    bus.subscribe((e) => events.push(e));
    const backend = fakeBackend({
      analyzeDocument: '{"summary": "S", "components": [{"type": "knob", "name": "Rise"}]}',
    });
    await makeWorker(db, backend, undefined, bus).tick();

    expect(events.length).toBeGreaterThan(0);
    const userIds = new Set(events.map((e) => e.userId));
    expect(userIds).toEqual(new Set([u1.id]));
  });

  it('chained analyze jobs inherit the find job owner', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'find_manual', { module_id: module.id, user_id: user.id });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com': { body: PDF_BYTES } });
    await makeWorker(db, backend, fetchImpl).tick();

    const { rows } = await db.query("SELECT * FROM jobs WHERE type = 'analyze_manual'");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(user.id);
  });

  it('processes a find_manual job and chains an analyze_manual job', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'find_manual', { module_id: module.id });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com': { body: PDF_BYTES } });
    const worker = makeWorker(db, backend, fetchImpl);

    const done = await worker.tick();
    expect(done.status).toBe('complete');

    const { rows: modules } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(modules[0].manual_status).toBe('found');

    const { rows: chained } = await db.query(
      `SELECT * FROM jobs WHERE type = 'analyze_manual' AND module_id = $1`,
      [module.id]
    );
    expect(chained).toHaveLength(1);
    expect(chained[0].status).toBe('pending');
  });

  it('chains a text extraction alongside the analysis when a manual is found', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'find_manual', { module_id: module.id, user_id: user.id });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
      analyzeDocument: '{"summary": "S", "components": []}',
    });
    const worker = makeWorker(db, backend, fakeFetch({ 'makenoise.com': { body: PDF_BYTES } }));
    await worker.tick(); // find_manual

    const { rows: queued } = await db.query(
      `SELECT * FROM jobs WHERE type = 'extract_manual' AND module_id = $1`,
      [module.id]
    );
    expect(queued).toHaveLength(1);
    const manual = await db.models.Manual.findOne({ where: { module_id: module.id } });
    // The job names the document it is to extract, not just the module.
    expect(JSON.parse(queued[0].payload)).toEqual({ manual_id: manual.id });

    // Running it stores the manual's text against that document.
    await worker.tick(); // analyze_manual (queued first)
    await worker.tick(); // extract_manual
    const document = await db.models.ManualDocument.findOne({ where: { manual_id: manual.id } });
    expect(document.content).toContain('Make Noise Maths');
    expect(document.user_id).toBeNull();
    expect(document.hash).toBe(manual.hash);
  });

  it('does not queue a second extraction for a document already queued', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    const manual = await db.models.Manual.findOne({ where: { module_id: module.id } });

    expect(await enqueueExtractManual(db, manual.get({ plain: true }), user.id)).toBeTruthy();
    expect(await enqueueExtractManual(db, manual.get({ plain: true }), user.id)).toBeNull();

    // A different document of the same module is its own job, though.
    const upload = await db.models.Manual.create({
      module_id: module.id,
      user_id: user.id,
      hash: 'e'.repeat(64),
      name: 'cheat sheet',
      source: 'upload',
    });
    expect(await enqueueExtractManual(db, upload.get({ plain: true }), user.id)).toBeTruthy();
    expect(await db.models.Job.count({ where: { type: 'extract_manual' } })).toBe(2);
  });

  it('fails an extraction whose document has gone', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'extract_manual', { module_id: module.id, user_id: user.id });
    const worker = makeWorker(db, fakeBackend());
    const done = await worker.tick();
    expect(done.error).toMatch(/no document to extract text from/);
  });

  it('builds the backend with the job type model override', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await db.query(
      "INSERT INTO app_config (key, value) VALUES ('llm_model_find_manual', 'claude-haiku-4-5')"
    );
    await enqueueJob(db, 'import', { userId: user.id, payload: { type: 'text', content: 'A,B' } });
    await enqueue(db, 'find_manual', { module_id: module.id });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const seen = [];
    const worker = makeWorker(db, backend, fakeFetch({ 'makenoise.com': { body: PDF_BYTES } }), null, {
      backendFactory: (settings) => {
        seen.push(settings);
        return backend;
      },
    });
    await worker.tick(); // import: no override key, global default applies
    await worker.tick(); // find_manual: per-type override applies

    expect(seen).toEqual([
      { provider: 'claude', model: 'claude-fable-5' },
      { provider: 'claude', model: 'claude-haiku-4-5' },
    ]);
  });

  it('find_manual falls back to rendering the product page as a PDF', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'find_manual', { module_id: module.id });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: [],
        product_page_url: 'https://makenoise.com/maths',
      }),
    });
    const rendered = [];
    const renderImpl = async (url, dest) => {
      rendered.push(url);
      fs.writeFileSync(dest, PDF_BYTES);
      return true;
    };
    const worker = makeWorker(db, backend, fakeFetch({}), null, { renderImpl });

    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(rendered).toEqual(['https://makenoise.com/maths']);

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_name).toBe('Make_Noise_Maths_Product_Page.pdf');
    expect(fs.existsSync(path.join(manualsDir, `${PDF_HASH}.pdf`))).toBe(true);
  });

  it('processes an analyze_manual job into components', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await enqueue(db, 'analyze_manual', { module_id: module.id });

    const backend = fakeBackend({
      analyzeDocument:
        '{"summary": "A function generator.", "components": [{"type": "output_jack", "name": "Out", "voltage_min": -10, "voltage_max": 10, "polarity": "bipolar"}]}',
    });
    const worker = makeWorker(db, backend);

    const done = await worker.tick();
    expect(done.status).toBe('complete');
    const { rows } = await db.query('SELECT * FROM module_components WHERE module_id = $1', [
      module.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('uses product-page jack inference for a rendered stand-in', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await db.models.Manual.update(
      { original_name: 'Make_Noise_Maths_Product_Page.pdf' },
      { where: { module_id: module.id } }
    );
    const companionHash = 'f'.repeat(64);
    fs.writeFileSync(path.join(manualsDir, `${companionHash}.pdf`), PDF_BYTES);
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: companionHash,
      original_name: 'Make_Noise_Maths_Perfect_Circuit_Product_Page.pdf',
      source: 'found',
    });
    await enqueue(db, 'analyze_manual', { module_id: module.id });
    const backend = fakeBackend({
      analyzeDocument:
        '{"summary":"A function generator.","components":[{"type":"output_jack","name":"OUT"}]}',
    });

    const done = await makeWorker(db, backend).tick();

    expect(done.status).toBe('complete');
    expect(backend.calls.analyzeDocument).toHaveLength(0);
    expect(backend.calls.analyzeDocuments[0][0]).toContain('rendered PRODUCT PAGES');
    expect(backend.calls.analyzeDocuments[0][0]).toContain('For JACKS ONLY');
    expect(backend.calls.analyzeDocuments[0][1]).toHaveLength(2);
  });

  // No Perfect Circuit listing for an open-source module, so the build document
  // the finder downloaded is what goes in beside the product page.
  it('analyzes the build document alongside a product page when there is no Perfect Circuit page', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manufacturer: 'Music Thing',
      name: 'Radio Music',
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await db.models.Manual.update(
      { original_name: 'Music_Thing_Radio_Music_Product_Page.pdf' },
      { where: { module_id: module.id } }
    );
    const buildHash = 'e'.repeat(64);
    fs.writeFileSync(path.join(manualsDir, `${buildHash}.pdf`), PDF_BYTES);
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: buildHash,
      original_name: 'Music_Thing_Radio_Music_Build_Document.pdf',
      source: 'found',
    });
    await enqueue(db, 'analyze_manual', { module_id: module.id });
    const backend = fakeBackend({
      analyzeDocument:
        '{"summary":"A sample player.","components":[{"type":"output_jack","name":"OUT"}]}',
    });

    expect((await makeWorker(db, backend).tick()).status).toBe('complete');

    const [prompt, submitted] = backend.calls.analyzeDocuments[0];
    expect(submitted).toEqual([
      path.join(manualsDir, `${PDF_HASH}.pdf`),
      path.join(manualsDir, `${buildHash}.pdf`),
    ]);
    // The prompt says what the second document is, so the BOM and the
    // soldering order are not read as panel components.
    expect(prompt).toContain('BUILD DOCUMENT');
    expect(prompt).toContain('part on the PCB is not a jack');
    expect(prompt).not.toContain("Perfect\nCircuit's page");
  });

  // Whatever the uploader called it, a build document they supplied beats one
  // nobody found.
  it("uses the requesting user's uploaded build document when nothing was found", async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const other = await createUser(db, { username: 'other' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await db.models.Manual.update(
      { original_name: 'Make_Noise_Maths_Product_Page.pdf' },
      { where: { module_id: module.id, user_id: null } }
    );
    const ownHash = 'a'.repeat(64);
    const otherHash = 'b'.repeat(64);
    for (const hash of [ownHash, otherHash]) {
      fs.writeFileSync(path.join(manualsDir, `${hash}.pdf`), PDF_BYTES);
    }
    await db.models.Manual.bulkCreate([
      {
        module_id: module.id,
        user_id: other.id,
        hash: otherHash,
        name: 'Build Guide',
        original_name: 'private-build.pdf',
        source: 'upload',
      },
      {
        module_id: module.id,
        user_id: user.id,
        hash: ownHash,
        name: 'Assembly instructions',
        original_name: 'maths-kit.pdf',
        source: 'upload',
      },
    ]);
    await enqueue(db, 'analyze_manual', { module_id: module.id, user_id: user.id });
    const backend = fakeBackend({
      analyzeDocument:
        '{"summary":"A function generator.","components":[{"type":"output_jack","name":"OUT"}]}',
    });

    expect((await makeWorker(db, backend).tick()).status).toBe('complete');

    const [prompt, submitted] = backend.calls.analyzeDocuments[0];
    expect(submitted).toEqual([
      path.join(manualsDir, `${PDF_HASH}.pdf`),
      path.join(manualsDir, `${ownHash}.pdf`),
    ]);
    expect(prompt).toContain('BUILD DOCUMENT');
  });

  // Perfect Circuit's listing reads jack by jack, so it stays the first choice
  // when the module has both.
  it('prefers the Perfect Circuit page over a build document', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await db.models.Manual.update(
      { original_name: 'Make_Noise_Maths_Product_Page.pdf' },
      { where: { module_id: module.id } }
    );
    const buildHash = 'e'.repeat(64);
    const pcHash = 'f'.repeat(64);
    for (const hash of [buildHash, pcHash]) {
      fs.writeFileSync(path.join(manualsDir, `${hash}.pdf`), PDF_BYTES);
    }
    await db.models.Manual.bulkCreate([
      {
        module_id: module.id,
        user_id: null,
        hash: buildHash,
        original_name: 'Make_Noise_Maths_Build_Document.pdf',
        source: 'found',
      },
      {
        module_id: module.id,
        user_id: null,
        hash: pcHash,
        original_name: 'Make_Noise_Maths_Perfect_Circuit_Product_Page.pdf',
        source: 'found',
      },
    ]);
    await enqueue(db, 'analyze_manual', { module_id: module.id });
    const backend = fakeBackend({
      analyzeDocument:
        '{"summary":"A function generator.","components":[{"type":"output_jack","name":"OUT"}]}',
    });

    expect((await makeWorker(db, backend).tick()).status).toBe('complete');

    const [prompt, submitted] = backend.calls.analyzeDocuments[0];
    expect(submitted).toEqual([
      path.join(manualsDir, `${PDF_HASH}.pdf`),
      path.join(manualsDir, `${pcHash}.pdf`),
    ]);
    expect(prompt).not.toContain('BUILD DOCUMENT');
  });

  it('includes only the requesting user\'s uploaded Perfect Circuit document with a product page', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const other = await createUser(db, { username: 'other' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    await db.models.Manual.update(
      { original_name: 'Make_Noise_Maths_Product_Page.pdf' },
      { where: { module_id: module.id, user_id: null } }
    );
    const ownHash = 'a'.repeat(64);
    const otherHash = 'b'.repeat(64);
    const notesHash = 'c'.repeat(64);
    const foundHash = 'd'.repeat(64);
    for (const hash of [ownHash, otherHash, notesHash, foundHash]) {
      fs.writeFileSync(path.join(manualsDir, `${hash}.pdf`), PDF_BYTES);
    }
    await db.models.Manual.bulkCreate([
      {
        module_id: module.id,
        user_id: null,
        hash: foundHash,
        original_name: 'Make_Noise_Maths_Perfect_Circuit_Product_Page.pdf',
        source: 'found',
      },
      {
        module_id: module.id,
        user_id: user.id,
        hash: ownHash,
        name: 'Perfect Circuit',
        original_name: 'maths-product-page.pdf',
        source: 'upload',
      },
      {
        module_id: module.id,
        user_id: other.id,
        hash: otherHash,
        name: 'Perfect_Circuit',
        original_name: 'private.pdf',
        source: 'upload',
      },
      {
        module_id: module.id,
        user_id: user.id,
        hash: notesHash,
        name: 'notes',
        original_name: 'notes.pdf',
        source: 'upload',
      },
    ]);
    await enqueue(db, 'analyze_manual', { module_id: module.id, user_id: user.id });
    const backend = fakeBackend({
      analyzeDocument:
        '{"summary":"A function generator.","components":[{"type":"output_jack","name":"OUT"}]}',
    });

    expect((await makeWorker(db, backend).tick()).status).toBe('complete');

    const submitted = backend.calls.analyzeDocuments[0][1];
    expect(submitted).toEqual([
      path.join(manualsDir, `${PDF_HASH}.pdf`),
      path.join(manualsDir, `${ownHash}.pdf`),
    ]);
  });

  it('processes a scope_question job and leaves the question awaiting review', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH, manual_status: 'found' });
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'scoping') RETURNING *`,
      [user.id]
    );
    await enqueue(db, 'scope_question', { question_id: q[0].id, user_id: user.id });

    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
    });
    const worker = makeWorker(db, backend);

    const done = await worker.tick();
    expect(done.status).toBe('complete');
    const { rows } = await db.query('SELECT * FROM questions WHERE id = $1', [q[0].id]);
    expect(rows[0].status).toBe('scoped');
    const { rows: links } = await db.query(
      'SELECT * FROM question_modules WHERE question_id = $1',
      [q[0].id]
    );
    expect(links.map((l) => l.module_id)).toEqual([module.id]);
    expect(backend.calls.answerWithDocuments).toHaveLength(0);
  });

  it('processes an answer_question job end to end', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'pending') RETURNING *`,
      [user.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      q[0].id,
      module.id,
    ]);
    const { rows: manual } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [
      module.id,
    ]);
    await db.query('INSERT INTO question_manuals (question_id, manual_id) VALUES ($1, $2)', [
      q[0].id,
      manual[0].id,
    ]);
    await enqueue(db, 'answer_question', { question_id: q[0].id });

    const backend = fakeBackend({ answerWithDocuments: 'Like this.' });
    const worker = makeWorker(db, backend);

    const done = await worker.tick();
    expect(done.status).toBe('complete');
    const { rows } = await db.query('SELECT * FROM questions WHERE id = $1', [q[0].id]);
    expect(rows[0].status).toBe('answered');
    expect(rows[0].answer).toBe('Like this.');
  });

  it('marks the question failed when answering fails', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await insertModule(db, user.id, { manual_hash: null });
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt) VALUES ($1, 'How?') RETURNING *`,
      [user.id]
    );
    const job = await enqueue(db, 'answer_question', { question_id: q[0].id });
    // Exhaust all attempts so the job fails permanently.
    await db.query('UPDATE jobs SET attempts = $2 WHERE id = $1', [job.id, MAX_ATTEMPTS - 1]);

    const backend = fakeBackend({ completeText: '[]' });
    const worker = makeWorker(db, backend);
    const done = await worker.tick();
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/in scope/);

    const { rows } = await db.query('SELECT * FROM questions WHERE id = $1', [q[0].id]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toMatch(/in scope/);
  });

  it('retries a failed job until MAX_ATTEMPTS then fails permanently', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await enqueue(db, 'find_manual', { module_id: module.id });

    const backend = fakeBackend({ completeTextWithSearch: new Error('LLM down') });
    const fetchImpl = fakeFetch({ 'archive.org/advancedsearch.php': { json: { response: { docs: [] } } } });
    const worker = makeWorker(db, backend, fetchImpl);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const result = await worker.tick();
      expect(result.status).toBe('pending');
      expect(result.attempts).toBe(i);
    }
    const final = await worker.tick();
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(MAX_ATTEMPTS);
  });

  it('fails cleanly when the module was deleted', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    const job = await enqueue(db, 'find_manual', { module_id: module.id });
    await db.query('UPDATE jobs SET module_id = NULL WHERE id = $1', [job.id]);

    const worker = makeWorker(db, fakeBackend());
    const done = await worker.tick();
    expect(['pending', 'failed']).toContain(done.status);
    expect(done.error).toBeTruthy();
  });

  it('start/stop polls the queue in the background', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    await enqueue(db, 'analyze_manual', { module_id: module.id });

    const backend = fakeBackend({
      analyzeDocument: '{"summary": "S", "components": [{"type": "knob", "name": "Rise"}]}',
    });
    const worker = createWorker(db, {
      manualsDir,
      backendFactory: () => backend,
      pollIntervalMs: 10,
      log: () => {},
    });
    worker.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      worker.stop();
    }
    const { rows } = await db.query('SELECT status FROM jobs');
    expect(rows[0].status).toBe('complete');
  });

  it('processes jobs concurrently with the configured number of workers', async () => {
    const db = await createTestDb();
    await db.query("INSERT INTO app_config (key, value) VALUES ('import_workers', '3')");
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    for (let i = 0; i < 3; i++) {
      const module = await insertModule(db, user.id, { name: `Module ${i}`, manual_hash: PDF_HASH });
      await enqueue(db, 'analyze_manual', { module_id: module.id });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const backend = fakeBackend({
      analyzeDocument: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
        return '{"summary": "S", "components": []}';
      },
    });
    const worker = createWorker(db, {
      manualsDir,
      backendFactory: () => backend,
      pollIntervalMs: 10,
      log: () => {},
    });
    worker.start();
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await db.query('SELECT status FROM jobs');
        if (rows.every((r) => r.status === 'complete')) break;
        if (Date.now() > deadline) throw new Error(`jobs did not finish: ${JSON.stringify(rows)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      worker.stop();
    }
    expect(maxInFlight).toBe(3);
  });

  it('runs jobs chained mid-drain (import → find_manual) at full concurrency', async () => {
    const db = await createTestDb();
    await db.query("INSERT INTO app_config (key, value) VALUES ('import_workers', '3')");
    const user = await createUser(db, { username: 'u' });
    await enqueueJob(db, 'import', {
      userId: user.id,
      payload: { type: 'text', content: 'Make Noise,Maths\nMake Noise,Rene\nMake Noise,Wogglebug' },
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const backend = fakeBackend({
      completeTextWithSearch: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
        return JSON.stringify({
          manufacturer: 'Make Noise',
          module: 'Maths',
          pdf_urls: ['https://makenoise.com/manual.pdf'],
          product_page_url: null,
        });
      },
      analyzeDocument: '{"summary": "S", "components": []}',
    });
    const worker = createWorker(db, {
      manualsDir,
      backendFactory: () => backend,
      fetchImpl: fakeFetch({ 'makenoise.com': { body: PDF_BYTES } }),
      extractImpl: fakeExtract,
      pollIntervalMs: 10,
      log: () => {},
    });
    worker.start();
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await db.query('SELECT status FROM jobs');
        if (rows.length >= 7 && rows.every((r) => r.status === 'complete')) break;
        if (Date.now() > deadline) throw new Error(`jobs did not finish: ${JSON.stringify(rows)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      worker.stop();
    }
    // The three find_manual jobs only exist once the import job is already
    // running; they must still be spread across the worker pool.
    expect(maxInFlight).toBe(3);
  });

  // A process killed mid-job (a redeploy recreating the container is enough)
  // leaves its jobs 'running' with nobody working on them. Without a lease
  // they stayed that way for good: never retried, and never re-queued either,
  // because the dedupe guards saw a live job for the module.
  describe('orphaned jobs', () => {
    async function insertRunning(db, moduleId, { heartbeatAt, attempts = 1 }) {
      const { rows } = await db.query(
        `INSERT INTO jobs (type, module_id, status, attempts, heartbeat_at, worker_id)
         VALUES ('analyze_manual', $1, 'running', $2, $3, 'dead-worker#1') RETURNING *`,
        [moduleId, attempts, heartbeatAt]
      );
      return rows[0];
    }

    it('requeues a running job whose worker stopped reporting progress', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      await db.query("UPDATE modules SET analysis_status = 'analyzing' WHERE id = $1", [module.id]);
      const stale = await insertRunning(db, module.id, {
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const worker = makeWorker(db, fakeBackend());
      const reclaimed = await worker.reclaimStaleJobs();

      expect(reclaimed.map((j) => j.id)).toEqual([stale.id]);
      const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [stale.id]);
      expect(rows[0].status).toBe('pending');
      expect(rows[0].attempts).toBe(1); // the lost attempt still counts
      expect(rows[0].error).toMatch(/worker stopped/);
      expect(rows[0].worker_id).toBeNull();
      // The module has to come off 'analyzing' too, or the UI shows work in
      // progress that nothing is doing.
      const { rows: mods } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
      expect(mods[0].analysis_status).toBe('pending');
    });

    it('fails an orphaned job that has no attempts left', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const stale = await insertRunning(db, module.id, {
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
        attempts: MAX_ATTEMPTS,
      });

      await makeWorker(db, fakeBackend()).reclaimStaleJobs();

      const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [stale.id]);
      expect(rows[0].status).toBe('failed');
      const { rows: mods } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
      expect(mods[0].analysis_status).toBe('failed');
    });

    it('leaves a job alone while its worker is still reporting', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const fresh = await insertRunning(db, module.id, { heartbeatAt: new Date() });

      expect(await makeWorker(db, fakeBackend()).reclaimStaleJobs()).toHaveLength(0);
      const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [fresh.id]);
      expect(rows[0].status).toBe('running');
    });

    it('never reclaims a job this worker is running right now', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);

      let reclaimedMidRun = null;
      // Even with every running job counting as stale, the one in flight here
      // must survive — reclaiming it would run the analysis twice.
      const worker = makeWorker(
        db,
        fakeBackend({
          analyzeDocument: async () => {
            reclaimedMidRun = await worker.reclaimStaleJobs();
            return '{"summary": "S", "components": []}';
          },
        }),
        null,
        null,
        { staleJobMs: 0 }
      );
      const done = await worker.tick();

      expect(reclaimedMidRun).toEqual([]);
      expect(done.status).toBe('complete');
    });

    it('hands in-flight jobs back to the queue when the worker is stopped', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);

      // The analysis never returns: the job is still genuinely in flight when
      // the process is told to shut down, exactly as during a deploy.
      let midAnalysis;
      const analysing = new Promise((resolve) => {
        midAnalysis = resolve;
      });
      const worker = makeWorker(
        db,
        fakeBackend({ analyzeDocument: () => (midAnalysis(), new Promise(() => {})) }),
        null,
        null,
        { pollIntervalMs: 10 }
      );
      worker.start();
      await analysing;
      await worker.stop();

      const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [job.id]);
      expect(rows[0].status).toBe('pending');
      // A deploy is not the job's fault, so the interrupted attempt is
      // refunded rather than counted against MAX_ATTEMPTS.
      expect(rows[0].attempts).toBe(0);
      expect(rows[0].error).toMatch(/shut down/);
    });

    it('picks orphaned jobs up again on the next poll', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
      const stale = await insertRunning(db, module.id, {
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const worker = makeWorker(
        db,
        fakeBackend({ analyzeDocument: '{"summary": "S", "components": []}' }),
        null,
        null,
        { pollIntervalMs: 10 }
      );
      worker.start();
      try {
        const deadline = Date.now() + 3000;
        for (;;) {
          const { rows } = await db.query('SELECT status FROM jobs WHERE id = $1', [stale.id]);
          if (rows[0].status === 'complete') break;
          if (Date.now() > deadline) throw new Error(`stalled job was not rerun: ${rows[0].status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await worker.stop();
      }
    });

    it('gives up on a job that never finishes, freeing the runner', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);

      const worker = makeWorker(
        db,
        fakeBackend({ analyzeDocument: () => new Promise(() => {}) }),
        null,
        null,
        { jobTimeoutMs: 50 }
      );
      const result = await worker.tick();

      expect(result.id).toBe(job.id);
      expect(result.status).toBe('pending'); // attempts left, so it goes back
      expect(result.error).toMatch(/time limit/);
    });

    it('widens the time limit with every attempt', () => {
      expect(attemptTimeoutMs(1000, 1)).toBe(1000);
      expect(attemptTimeoutMs(1000, 2)).toBe(2000);
      expect(attemptTimeoutMs(1000, 3)).toBe(3000);
      // A row from before attempts were counted still gets one full limit.
      expect(attemptTimeoutMs(1000, 0)).toBe(1000);
    });

    it('lets a retry finish work that was too slow for the first attempt', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);

      // Work that takes longer than one limit but well inside two of them.
      const slow = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(JSON.stringify({ summary: 'slow', components: [] })), 450);
        });
      const worker = makeWorker(db, fakeBackend({ analyzeDocument: slow }), null, null, {
        jobTimeoutMs: 300,
      });

      const first = await worker.tick();
      expect(first.attempts).toBe(1);
      expect(first.status).toBe('pending');
      expect(first.error).toMatch(/time limit/);

      // Second attempt: 600ms of room, so the same work lands.
      const second = await worker.tick();
      expect(second.attempts).toBe(2);
      expect(second.status).toBe('complete');
    });

    it('keeps the heartbeat fresh while a long job runs', async () => {
      const db = await createTestDb();
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);

      let beat = null;
      const worker = makeWorker(
        db,
        fakeBackend({
          analyzeDocument: async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            const { rows } = await db.query('SELECT heartbeat_at FROM jobs WHERE id = $1', [job.id]);
            beat = rows[0].heartbeat_at;
            return '{"summary": "S", "components": []}';
          },
        }),
        null,
        null,
        { pollIntervalMs: 10, heartbeatMs: 20 }
      );
      const claimedAt = new Date();
      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await worker.stop();

      expect(beat).toBeTruthy();
      expect(new Date(beat).getTime()).toBeGreaterThanOrEqual(claimedAt.getTime());
    });
  });

  // Stopping a job cannot interrupt its runner — handlers have no
  // cancellation to offer — so the row is taken off the queue instead and the
  // runner has to notice on its way out.
  describe('jobs stopped mid-flight', () => {
    async function analyzeJob(db) {
      const user = await createUser(db, { username: 'u' });
      const module = await insertModule(db, user.id);
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      return { user, module, job };
    }

    it('leaves a job cancelled rather than completing it', async () => {
      const db = await createTestDb();
      const { job } = await analyzeJob(db);

      // Cancel the row while the analysis is in the model's hands.
      const analyzeDocument = async () => {
        await db.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [job.id]);
        return JSON.stringify({ summary: 'done anyway', components: [] });
      };
      const result = await makeWorker(db, fakeBackend({ analyzeDocument })).tick();

      expect(result.status).toBe('cancelled');
      const { rows } = await db.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
      expect(rows[0].status).toBe('cancelled');
    });

    it('leaves a cancelled job cancelled when its attempt fails too', async () => {
      const db = await createTestDb();
      const { job } = await analyzeJob(db);

      const analyzeDocument = async () => {
        await db.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [job.id]);
        throw new Error('boom');
      };
      const result = await makeWorker(db, fakeBackend({ analyzeDocument })).tick();

      expect(result.status).toBe('cancelled');
      // Not 'pending': a stopped job must not put itself back on the queue.
      const { rows } = await db.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
      expect(rows[0].status).toBe('cancelled');
    });

    it('survives the row being deleted out from under a running job', async () => {
      const db = await createTestDb();
      const { job } = await analyzeJob(db);

      const analyzeDocument = async () => {
        await db.query('DELETE FROM jobs WHERE id = $1', [job.id]);
        return JSON.stringify({ summary: 'done anyway', components: [] });
      };
      const result = await makeWorker(db, fakeBackend({ analyzeDocument })).tick();

      expect(result).toBeNull();
      expect((await db.query('SELECT id FROM jobs')).rows).toHaveLength(0);
    });
  });

  // One exhausted subscription would otherwise take the whole queue down with
  // it three attempts at a time, and leave every module it touched 'failed'.
  describe('the provider running out of tokens', () => {
    // Enough of a module, manual and job for an analyze_manual run.
    async function analyzeJob(db, { username = 'u' } = {}) {
      const user = await createUser(db, { username });
      const module = await insertModule(db, user.id);
      await db.query(
        `INSERT INTO manuals (module_id, hash, source, original_name)
         VALUES ($1, $2, 'found', 'm.pdf')`,
        [module.id, PDF_HASH]
      );
      fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
      const job = await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: user.id });
      return { user, module, job };
    }

    const outOfTokens = () =>
      new Error('claude failed (exit 1):\nClaude AI usage limit reached|1893456000');

    beforeEach(() => {
      takeQuotaExhaustion(); // no leftovers from another test
    });

    it('pauses the queue until the limit lifts', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      const worker = makeWorker(db, fakeBackend({ analyzeDocument: outOfTokens() }));

      await worker.tick();

      const pause = await getQueuePause(db);
      expect(pause.paused).toBe(true);
      expect(pause.until).toBe(new Date(1893456000 * 1000).toISOString());
      expect(pause.reason).toMatch(/usage limit reached/);
    });

    it('puts the job back on the queue without spending an attempt on it', async () => {
      const db = await createTestDb();
      const { job } = await analyzeJob(db);
      const worker = makeWorker(db, fakeBackend({ analyzeDocument: outOfTokens() }));

      const result = await worker.tick();

      expect(result.status).toBe('pending');
      // Claiming it counted an attempt; running out of tokens is not one of
      // the three tries the work itself gets.
      expect(result.attempts).toBe(0);
      expect(result.error).toMatch(/out of tokens/);
      const { rows } = await db.query('SELECT status, attempts FROM jobs WHERE id = $1', [job.id]);
      expect(rows[0].status).toBe('pending');
      expect(Number(rows[0].attempts)).toBe(0);
    });

    it('claims nothing while the queue is paused', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      await pauseQueue(db, { until: Date.now() + 60 * 60 * 1000, reason: 'out of tokens' });

      const backend = fakeBackend({ analyzeDocument: '{"summary": "S", "components": []}' });
      expect(await makeWorker(db, backend).tick()).toBeNull();
      expect(backend.calls.analyzeDocument).toHaveLength(0);
      const { rows } = await db.query('SELECT status FROM jobs');
      expect(rows[0].status).toBe('pending');
    });

    it('starts again by itself once the pause has run its course', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      await pauseQueue(db, { until: Date.now() - 1000, reason: 'out of tokens' });

      const backend = fakeBackend({ analyzeDocument: '{"summary": "S", "components": []}' });
      const done = await makeWorker(db, backend).tick();

      expect(done.status).toBe('complete');
      // And the spent pause is cleared out rather than left to be re-read.
      expect((await getQueuePause(db)).paused).toBe(false);
    });

    it('pauses even when the job that spent the tokens got away with it', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      // find_manual swallows a failed research call and falls back to
      // archive.org, so a job can finish with the subscription exhausted:
      // the CLI records it (services/llm.js) and the worker collects it.
      const analyzeDocument = async () => {
        noteQuotaExhaustion({ message: 'out of usage credits', resetAt: null });
        return '{"summary": "S", "components": []}';
      };
      const worker = makeWorker(db, fakeBackend({ analyzeDocument }), null, null, {
        quotaPauseMs: 30 * 60 * 1000,
      });

      const done = await worker.tick();

      expect(done.status).toBe('complete');
      const pause = await getQueuePause(db);
      expect(pause.paused).toBe(true);
      expect(pause.reason).toBe('out of usage credits');
      // Nothing said when the limit lifts, so the queue takes the fallback.
      expect(new Date(pause.until).getTime()).toBeGreaterThan(Date.now() + 25 * 60 * 1000);
    });

    it('tells every connected user, not just the owner of the job', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      const events = [];
      const bus = { publish: () => {}, publishAll: (e) => events.push(e) };
      await makeWorker(db, fakeBackend({ analyzeDocument: outOfTokens() }), null, bus).tick();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'queue', event: 'paused', paused: true });
    });

    it('leaves an ordinary failure to the usual retries', async () => {
      const db = await createTestDb();
      await analyzeJob(db);
      const worker = makeWorker(db, fakeBackend({ analyzeDocument: new Error('LLM down') }));

      const result = await worker.tick();

      expect(result.status).toBe('pending');
      expect(result.attempts).toBe(1);
      expect((await getQueuePause(db)).paused).toBe(false);
    });
  });

  it('falls back to the default worker count when the stored value is unusable', async () => {
    const db = await createTestDb();
    expect(await getImportWorkerCount(db)).toBe(DEFAULT_IMPORT_WORKERS);
    // Bypasses setConfig validation to simulate a corrupt row.
    await db.query("INSERT INTO app_config (key, value) VALUES ('import_workers', 'banana')");
    expect(await getImportWorkerCount(db)).toBe(DEFAULT_IMPORT_WORKERS);
  });
});
