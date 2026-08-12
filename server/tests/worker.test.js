import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTestDb,
  createUser,
  insertModule,
  fakeBackend,
  fakeFetch,
  PDF_BYTES,
  PDF_HASH,
} from './helpers.js';
import { createWorker, enqueueJob, enqueueFindManual, MAX_ATTEMPTS } from '../src/jobs/worker.js';
import { createBus } from '../src/events.js';

let manualsDir;
beforeEach(() => {
  manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-manuals-'));
});
afterEach(() => {
  fs.rmSync(manualsDir, { recursive: true, force: true });
});

function makeWorker(db, backend, fetchImpl, bus) {
  return createWorker(db, {
    manualsDir,
    backendFactory: () => backend,
    fetchImpl: fetchImpl || fakeFetch({}),
    bus,
    log: () => {},
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
      'SELECT * FROM user_modules WHERE user_id = $1',
      [user.id]
    );
    expect(mappings).toHaveLength(2);

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
    const { rows: mappings } = await db.query('SELECT quantity FROM user_modules');
    expect(mappings[0].quantity).toBe(2);
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
    const { rows: mappings } = await db.query('SELECT user_id FROM user_modules ORDER BY user_id');
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
    await db.query('INSERT INTO user_modules (user_id, module_id) VALUES ($1, $2)', [
      u2.id,
      module.id,
    ]);
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

  it('processes an answer_question job end to end', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    await insertModule(db, user.id, { manual_hash: PDF_HASH, manual_status: 'found' });
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt) VALUES ($1, 'How?') RETURNING *`,
      [user.id]
    );
    await enqueue(db, 'answer_question', { question_id: q[0].id });

    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
      answerWithDocuments: 'Like this.',
    });
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
});
