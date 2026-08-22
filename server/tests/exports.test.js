import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, fakeBackend, fakeFetch, PDF_BYTES, PDF_HASH } from './helpers.js';
import { manualPath, isProbablyPdfBuffer } from '../src/services/pdf.js';
import { createZip, crc32 } from '../src/services/zip.js';
import { textToPdf } from '../src/services/textPdf.js';
import { exportFilePath, pruneOldExports, EXPORT_MAX_AGE_MS } from '../src/services/rackExport.js';
import { createWorker } from '../src/jobs/worker.js';
import { createBus } from '../src/events.js';

// Reads the entry names and stored bytes back out of a zip produced by
// createZip (store-only entries), by walking the local file headers.
function readZipEntries(zip) {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const entries = [];
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = zip.subarray(
      offset + 30 + nameLength + extraLength,
      offset + 30 + nameLength + extraLength + size
    );
    entries.push({ name, data });
    offset += 30 + nameLength + extraLength + size;
  }
  return entries;
}

function makeWorker(db, { manualsDir, exportsDir }, bus = null) {
  return createWorker(db, {
    manualsDir,
    exportsDir,
    backendFactory: () => fakeBackend(),
    fetchImpl: fakeFetch({}),
    renderImpl: async () => false,
    bus,
    log: () => {},
  });
}

describe('zip service', () => {
  it('crc32 matches the known value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('produces a zip whose entries round-trip', () => {
    const entries = [
      { name: 'a/b/one.pdf', data: PDF_BYTES },
      { name: 'two.txt', data: Buffer.from('hello') },
    ];
    const zip = createZip(entries, { now: new Date('2026-08-12T10:00:00') });
    const back = readZipEntries(zip);
    expect(back.map((e) => e.name)).toEqual(['a/b/one.pdf', 'two.txt']);
    expect(back[0].data.equals(PDF_BYTES)).toBe(true);
    expect(back[1].data.toString()).toBe('hello');
    // End-of-central-directory record sits at the tail with both counts.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
  });
});

describe('textPdf service', () => {
  it('renders paragraphs to a valid PDF, escaping delimiters and paginating', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} with (parens) \\ …`).join('\n');
    const pdf = textToPdf([{ text: 'Title', bold: true }, { text: long }]);
    expect(isProbablyPdfBuffer(pdf).ok).toBe(true);
    const text = pdf.toString('latin1');
    expect(text).toContain('\\(parens\\)');
    expect(text).toContain('%%EOF');
    // 300+ lines cannot fit one page.
    expect((text.match(/\/Type \/Page[^s]/g) || []).length).toBeGreaterThan(1);
  });
});

describe('rack export', () => {
  // Full flow: queue via the API, build in the worker, download once.
  it('zips manuals, notes and questions and serves the zip exactly once', async () => {
    const { app, db, manualsDir, exportsDir, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');
    const module = await insertModule(db, alice.id, { manual_hash: PDF_HASH });
    fs.writeFileSync(manualPath(manualsDir, PDF_HASH), PDF_BYTES);
    const component = await db.models.ModuleComponent.create({
      module_id: module.id,
      type: 'input_jack',
      name: 'In',
    });

    // Alice's note on the module and question on the jack are included; the
    // admin's note on the same module must not leak into her export.
    const note = await db.models.Note.create({
      user_id: alice.id,
      title: 'Patch idea',
      body: 'self-patch rise into cycle',
    });
    await db.models.NoteModule.create({ note_id: note.id, module_id: module.id });
    const adminNote = await db.models.Note.create({ user_id: admin.id, body: 'secret' });
    await db.models.NoteModule.create({ note_id: adminNote.id, module_id: module.id });
    const question = await db.models.Question.create({
      user_id: alice.id,
      prompt: 'What voltage range does the In jack accept?',
      answer: 'It accepts ±10V.',
      status: 'answered',
    });
    await db.models.QuestionComponent.create({
      question_id: question.id,
      component_id: component.id,
    });

    const bus = createBus();
    const events = [];
    bus.subscribe((e) => events.push(e));

    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const res = await request(app)
      .post(`/api/racks/${racks[0].id}/export`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(202);
    const jobId = res.body.id;
    expect(res.body.type).toBe('export_rack');

    // Queueing again while the first job is still pending reuses it.
    const again = await request(app)
      .post(`/api/racks/${racks[0].id}/export`)
      .set('Cookie', aliceCookie);
    expect(again.body.id).toBe(jobId);
    expect(again.body.reused).toBe(true);

    const worker = makeWorker(db, { manualsDir, exportsDir }, bus);
    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(fs.existsSync(exportFilePath(exportsDir, jobId))).toBe(true);

    // The completed WebSocket event carries the download link the client
    // auto-downloads, and the rack label.
    const completed = events.find((e) => e.kind === 'job' && e.event === 'completed');
    expect(completed.userId).toBe(alice.id);
    expect(completed.job.download).toBe(`/api/exports/${jobId}`);
    expect(completed.job.rack_name).toBe('main rack');

    // The jobs API exposes the same link to the owner…
    const jobs = (await request(app).get('/api/jobs').set('Cookie', aliceCookie)).body.jobs;
    expect(jobs.find((j) => j.id === jobId).download).toBe(`/api/exports/${jobId}`);
    // …but not to the admin (owner-only download).
    const adminJobs = (await request(app).get('/api/jobs').set('Cookie', adminCookie)).body.jobs;
    expect(adminJobs.find((j) => j.id === jobId).download).toBeNull();

    // Only the owner can fetch it.
    expect(
      (await request(app).get(`/api/exports/${jobId}`).set('Cookie', adminCookie)).status
    ).toBe(404);

    const fetchZip = () =>
      request(app)
        .get(`/api/exports/${jobId}`)
        .set('Cookie', aliceCookie)
        .buffer(true)
        .parse((res2, cb) => {
          const chunks = [];
          res2.on('data', (c) => chunks.push(c));
          res2.on('end', () => cb(null, Buffer.concat(chunks)));
        });

    const download = await fetchZip();
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toContain('main_rack.zip');

    const entries = readZipEntries(download.body);
    const manualId = (await db.models.Manual.findOne({ where: { module_id: module.id } })).id;
    expect(entries.map((e) => e.name).sort()).toEqual(
      [
        `Make_Noise/Maths/manuals/Make_Noise_Maths_manuals_${manualId}.pdf`,
        `Make_Noise/Maths/notes/Make_Noise_Maths_notes_${note.id}.pdf`,
        `Make_Noise/Maths/questions/Make_Noise_Maths_questions_${question.id}.pdf`,
      ].sort()
    );
    for (const entry of entries) expect(isProbablyPdfBuffer(entry.data).ok).toBe(true);
    const notePdf = entries.find((e) => e.name.includes('/notes/')).data.toString('latin1');
    expect(notePdf).toContain('self-patch rise into cycle');
    expect(notePdf).not.toContain('secret');
    const questionPdf = entries
      .find((e) => e.name.includes('/questions/'))
      .data.toString('latin1');
    expect(questionPdf).toContain('It accepts');

    // The zip is one-shot: served once, then removed from disk and the link
    // goes dead until a new export is queued. The removal happens after the
    // response has been written, so it is waited for rather than assumed to
    // have already happened by some fixed number of milliseconds later.
    //
    // A transfer the client tears down before the response finishes is an
    // abort as far as the server is concerned, and an aborted download
    // deliberately keeps the file so it can be fetched again — which is what
    // the retry here exercises. In-process supertest occasionally ends the
    // socket that way on a loaded machine even though the whole body arrived
    // (asserted above), so a zip still on disk means "fetch it again", not
    // "the one-shot rule is broken".
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < 200 && fs.existsSync(exportFilePath(exportsDir, jobId)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!fs.existsSync(exportFilePath(exportsDir, jobId))) break;
      expect((await fetchZip()).status).toBe(200);
    }
    expect(fs.existsSync(exportFilePath(exportsDir, jobId))).toBe(false);
    expect(
      (await request(app).get(`/api/exports/${jobId}`).set('Cookie', aliceCookie)).status
    ).toBe(404);
    const after = (await request(app).get('/api/jobs').set('Cookie', aliceCookie)).body.jobs;
    expect(after.find((j) => j.id === jobId).download).toBeNull();
    // Longer than the 5s default: this builds a rack's worth of PDFs, zips
    // them, downloads the zip and waits for the one-shot cleanup — with a
    // retry if the transfer was torn down early.
  }, 20000);

  it('fails the job when the rack is empty and 400s while not ready', async () => {
    const { app, db, manualsDir, exportsDir, aliceCookie } = await createTestApp();
    const created = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .send({ name: 'empty' });
    const res = await request(app)
      .post(`/api/racks/${created.body.id}/export`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(202);

    // Not ready yet: the download route refuses.
    expect(
      (await request(app).get(`/api/exports/${res.body.id}`).set('Cookie', aliceCookie)).status
    ).toBe(400);

    const worker = makeWorker(db, { manualsDir, exportsDir });
    const attempt = await worker.tick();
    expect(attempt.status).toBe('pending'); // will retry, then fail
    expect(attempt.error).toContain('no modules');
    expect(fs.existsSync(exportFilePath(exportsDir, res.body.id))).toBe(false);
  });

  it("cannot export another user's rack", async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await insertModule(db, rows[0].id);
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    expect(
      (await request(app).post(`/api/racks/${racks[0].id}/export`).set('Cookie', adminCookie))
        .status
    ).toBe(404);
  });

  it('prunes exports older than the retention window', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'prune-'));
    const stale = path.join(dir, 'rack-export-1.zip');
    const fresh = path.join(dir, 'rack-export-2.zip');
    const other = path.join(dir, 'keep.txt');
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, 'x');
    const old = Date.now() - EXPORT_MAX_AGE_MS - 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    pruneOldExports(dir);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
