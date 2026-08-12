import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule, PDF_BYTES, PDF_HASH } from './helpers.js';

describe('modules API', () => {
  it('lists only the current user’s modules', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');
    await insertModule(db, alice.id, { manufacturer: 'Make Noise', name: 'Maths' });
    await insertModule(db, admin.id, { manufacturer: 'ALM', name: 'Pam' });

    const res = await request(app).get('/api/modules').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Maths');
  });

  it('returns module detail with components', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, {
      summary: 'A function generator.',
      analysis_status: 'complete',
    });
    await db.query(
      `INSERT INTO module_components (module_id, type, name, description, voltage_min, voltage_max, polarity)
       VALUES ($1, 'input_jack', 'Signal In', 'Input', -5, 5, 'bipolar')`,
      [module.id]
    );

    const res = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('A function generator.');
    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0]).toMatchObject({
      type: 'input_jack',
      name: 'Signal In',
      polarity: 'bipolar',
    });
  });

  it("hides unmapped modules; delete only unlinks the user's mapping", async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);

    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/modules/${module.id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);
    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie)).status
    ).toBe(404);

    // The shared module record survives for other users.
    const { rows: still } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(still).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const { app } = await createTestApp();
    expect((await request(app).get('/api/modules')).status).toBe(401);
  });
});

describe('module documents API', () => {
  const pdfBase64 = PDF_BYTES.toString('base64');
  // A second, distinct PDF (different content hash than PDF_BYTES).
  const OTHER_BYTES = Buffer.concat([PDF_BYTES, Buffer.from('% alternate\n')]);
  const otherBase64 = OTHER_BYTES.toString('base64');
  const MINE_HASH = 'b'.repeat(64);
  const SECRET_HASH = 'c'.repeat(64);

  async function withModule() {
    const fixture = await createTestApp();
    const { rows } = await fixture.db.query("SELECT id FROM users WHERE username = 'alice'");
    fixture.alice = rows[0];
    fixture.module = await insertModule(fixture.db, rows[0].id, {
      manual_hash: PDF_HASH,
    });
    fs.writeFileSync(path.join(fixture.manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    return fixture;
  }

  it('lists the shared manual plus own uploads in module detail', async () => {
    const { app, db, aliceCookie, alice, module } = await withModule();
    await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, original_name, source)
       VALUES ($1, $2, '${MINE_HASH}', 'my-notes.pdf', 'upload')`,
      [module.id, alice.id]
    );
    // Another user's private document on the same shared module.
    const { rows: admin } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    await mapModule(db, admin[0].id, module.id);
    await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, source)
       VALUES ($1, $2, '${SECRET_HASH}', 'upload')`,
      [module.id, admin[0].id]
    );

    const res = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    const hashes = res.body.manuals.map((m) => m.hash);
    expect(hashes).toContain(PDF_HASH);
    expect(hashes).toContain(MINE_HASH);
    expect(hashes).not.toContain(SECRET_HASH);
  });

  it('uploads a PDF document private to the user, stored by content hash', async () => {
    const { app, db, aliceCookie, manualsDir, module } = await withModule();
    const res = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'calibration guide', filename: 'extra notes.pdf', data_base64: otherBase64 });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('upload');
    expect(res.body.name).toBe('calibration guide');
    expect(res.body.original_name).toBe('extra notes.pdf');
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(manualsDir, `${res.body.hash}.pdf`))).toBe(true);

    const { rows } = await db.query('SELECT * FROM manuals WHERE id = $1', [res.body.id]);
    expect(rows[0].user_id).not.toBeNull();
    expect(rows[0].hash).toBe(res.body.hash);
  });

  it('re-uploading the same content references the existing record', async () => {
    const { app, db, aliceCookie, module } = await withModule();
    const first = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'notes', filename: 'notes.pdf', data_base64: otherBase64 });
    expect(first.status).toBe(201);
    const again = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'notes again', filename: 'renamed.pdf', data_base64: otherBase64 });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const { rows } = await db.query(
      'SELECT * FROM manuals WHERE module_id = $1 AND user_id IS NOT NULL',
      [module.id]
    );
    expect(rows).toHaveLength(1);
  });

  it('serves documents by hash, but never other users’ private documents', async () => {
    const { app, aliceCookie, adminCookie, module } = await withModule();
    // Shared manual: any authenticated user can retrieve it.
    const shared = await request(app).get(`/api/manuals/${PDF_HASH}`).set('Cookie', aliceCookie);
    expect(shared.status).toBe(200);
    expect(shared.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(shared.body, PDF_BYTES)).toBe(0);

    // Alice's private upload: only alice can retrieve it.
    const upload = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'private notes', filename: 'private.pdf', data_base64: otherBase64 });
    const mine = await request(app)
      .get(`/api/manuals/${upload.body.hash}`)
      .set('Cookie', aliceCookie);
    expect(mine.status).toBe(200);
    expect(
      (await request(app).get(`/api/manuals/${upload.body.hash}`).set('Cookie', adminCookie))
        .status
    ).toBe(404);

    expect((await request(app).get(`/api/manuals/${PDF_HASH}`)).status).toBe(401);
    expect(
      (await request(app).get('/api/manuals/not-a-hash').set('Cookie', aliceCookie)).status
    ).toBe(404);
  });

  it('exports a document as an attachment named Manufacturer_Module_Name.pdf', async () => {
    const { app, aliceCookie, adminCookie, module } = await withModule();
    // Shared manual (name defaults to 'manual') on the Make Noise Maths module.
    const shared = await request(app)
      .get(`/api/manuals/${PDF_HASH}/export`)
      .set('Cookie', aliceCookie);
    expect(shared.status).toBe(200);
    expect(shared.headers['content-type']).toContain('application/pdf');
    expect(shared.headers['content-disposition']).toBe(
      'attachment; filename="Make_Noise_Maths_manual.pdf"'
    );
    expect(Buffer.compare(shared.body, PDF_BYTES)).toBe(0);

    // Own uploads export too, named after their database name.
    const upload = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'calibration guide', filename: 'x.pdf', data_base64: otherBase64 });
    const mine = await request(app)
      .get(`/api/manuals/${upload.body.hash}/export`)
      .set('Cookie', aliceCookie);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-disposition']).toBe(
      'attachment; filename="Make_Noise_Maths_calibration_guide.pdf"'
    );

    // Same access rules as retrieval: no exporting other users' documents.
    expect(
      (
        await request(app)
          .get(`/api/manuals/${upload.body.hash}/export`)
          .set('Cookie', adminCookie)
      ).status
    ).toBe(404);
    expect((await request(app).get(`/api/manuals/${PDF_HASH}/export`)).status).toBe(401);
  });

  it('rejects non-PDF uploads and uploads to unmapped modules', async () => {
    const { app, aliceCookie, adminCookie, module } = await withModule();
    expect(
      (
        await request(app)
          .post(`/api/modules/${module.id}/manuals`)
          .set('Cookie', aliceCookie)
          .send({ name: 'x', filename: 'x.pdf', data_base64: Buffer.from('<html>').toString('base64') })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/modules/${module.id}/manuals`)
          .set('Cookie', adminCookie)
          .send({ name: 'x', filename: 'x.pdf', data_base64: pdfBase64 })
      ).status
    ).toBe(404);
  });

  it('rejects reusing a database name for different content', async () => {
    const { app, db, aliceCookie, module } = await withModule();
    const third = Buffer.concat([PDF_BYTES, Buffer.from('% third\n')]).toString('base64');
    const first = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'notes', filename: 'a.pdf', data_base64: otherBase64 });
    expect(first.status).toBe(201);

    const clash = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'notes', filename: 'b.pdf', data_base64: third });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already have a document named/);

    // The unique index on (module_id, name, hash) also blocks exact
    // duplicates at the database level.
    await expect(
      db.query(
        `INSERT INTO manuals (module_id, user_id, hash, name, source)
         VALUES ($1, NULL, '${PDF_HASH}', 'manual', 'found')`,
        [module.id]
      )
    ).rejects.toThrow();
  });

  it("requires a document name and reserves 'manual' for the shared manual", async () => {
    const { app, aliceCookie, module } = await withModule();
    const post = (body) =>
      request(app).post(`/api/modules/${module.id}/manuals`).set('Cookie', aliceCookie).send(body);
    expect((await post({ filename: 'x.pdf', data_base64: otherBase64 })).status).toBe(400);
    expect(
      (await post({ name: '   ', filename: 'x.pdf', data_base64: otherBase64 })).status
    ).toBe(400);
    expect(
      (await post({ name: 'Manual', filename: 'x.pdf', data_base64: otherBase64 })).status
    ).toBe(400);
  });

  it('deletes own uploads but never the shared manual', async () => {
    const { app, db, aliceCookie, manualsDir, module } = await withModule();
    // Same content as the shared manual: the record dedupes per user, and the
    // file must survive the delete because the shared record still needs it.
    const upload = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'notes', filename: 'notes.pdf', data_base64: pdfBase64 });
    // Unique content: its file goes away with the last (only) record.
    const unique = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'unique notes', filename: 'unique.pdf', data_base64: otherBase64 });

    expect(
      (
        await request(app)
          .delete(`/api/modules/${module.id}/manuals/${upload.body.id}`)
          .set('Cookie', aliceCookie)
      ).status
    ).toBe(200);
    expect(fs.existsSync(path.join(manualsDir, `${PDF_HASH}.pdf`))).toBe(true);

    expect(
      (
        await request(app)
          .delete(`/api/modules/${module.id}/manuals/${unique.body.id}`)
          .set('Cookie', aliceCookie)
      ).status
    ).toBe(200);
    expect(fs.existsSync(path.join(manualsDir, `${unique.body.hash}.pdf`))).toBe(false);

    const { rows: shared } = await db.query(
      'SELECT id FROM manuals WHERE module_id = $1 AND user_id IS NULL',
      [module.id]
    );
    expect(
      (
        await request(app)
          .delete(`/api/modules/${module.id}/manuals/${shared[0].id}`)
          .set('Cookie', aliceCookie)
      ).status
    ).toBe(404);
  });
});

describe('imports API', () => {
  it('queues an async import job owned by the user', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/imports')
      .set('Cookie', aliceCookie)
      .send({ type: 'text', content: 'Make Noise,Maths\nMutable Instruments,Beads' });
    expect(res.status).toBe(202);
    expect(res.body.job_id).toBeDefined();
    expect(res.body.status).toBe('pending');

    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'import'");
    expect(jobs).toHaveLength(1);
    const { rows: alice } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    expect(jobs[0].user_id).toBe(alice[0].id);
    expect(JSON.parse(jobs[0].payload).content).toContain('Make Noise,Maths');

    // No modules exist until the worker runs the job.
    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(0);
  });

  it('accepts csv and modulargrid imports', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    expect(
      (
        await request(app)
          .post('/api/imports')
          .set('Cookie', aliceCookie)
          .send({ type: 'csv', content: '"ALM","Pam",1,""' })
      ).status
    ).toBe(202);
    expect(
      (
        await request(app)
          .post('/api/imports')
          .set('Cookie', aliceCookie)
          .send({ type: 'modulargrid', url: 'https://modulargrid.net/e/racks/view/999' })
      ).status
    ).toBe(202);
    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'import'");
    expect(jobs).toHaveLength(2);
  });

  it('validates the request body', async () => {
    const { app, aliceCookie } = await createTestApp();
    expect(
      (await request(app).post('/api/imports').set('Cookie', aliceCookie).send({ type: 'nope' }))
        .status
    ).toBe(400);
    expect(
      (await request(app).post('/api/imports').set('Cookie', aliceCookie).send({ type: 'csv' }))
        .status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/imports')
          .set('Cookie', aliceCookie)
          .send({ type: 'modulargrid', url: 'https://example.com/not-a-rack' })
      ).status
    ).toBe(400);
    expect((await request(app).post('/api/imports').send({ type: 'csv', content: 'x' })).status).toBe(
      401
    );
  });
});

describe('config API', () => {
  it('returns defaults with provider/model options for the admin', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.llm_provider).toBe('claude');
    expect(res.body.import_workers).toBe('4');
    expect(res.body.providers).toEqual(['claude', 'codex']);
    expect(res.body.known_models.claude).toContain('claude-fable-5');
  });

  it('updates import_workers and rejects non-integer values', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ import_workers: 8 });
    expect(res.status).toBe(200);
    expect(res.body.import_workers).toBe('8');

    const again = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(again.body.import_workers).toBe('8');

    for (const bad of ['three', 4.5, 0, -1, '', null, true]) {
      const rejected = await request(app)
        .put('/api/config')
        .set('Cookie', adminCookie)
        .send({ import_workers: bad });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatch(/import_workers/);
    }
    // A numeric string is accepted and normalized.
    const asString = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ import_workers: '2' });
    expect(asString.status).toBe(200);
    expect(asString.body.import_workers).toBe('2');
  });

  it('updates provider and model', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ llm_provider: 'codex', llm_model: 'gpt-5.1-codex' });
    expect(res.status).toBe(200);
    expect(res.body.llm_provider).toBe('codex');

    const again = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(again.body.llm_provider).toBe('codex');
    expect(again.body.llm_model).toBe('gpt-5.1-codex');
  });

  it('rejects invalid providers', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ llm_provider: 'openai-api' });
    expect(res.status).toBe(400);
  });

  it('is admin-only', async () => {
    const { app, aliceCookie } = await createTestApp();
    expect((await request(app).get('/api/config').set('Cookie', aliceCookie)).status).toBe(403);
    expect(
      (
        await request(app)
          .put('/api/config')
          .set('Cookie', aliceCookie)
          .send({ llm_provider: 'codex' })
      ).status
    ).toBe(403);
  });
});

describe('questions API', () => {
  async function withModules() {
    const fixture = await createTestApp();
    const { rows } = await fixture.db.query("SELECT id FROM users WHERE username = 'alice'");
    fixture.alice = rows[0];
    await insertModule(fixture.db, fixture.alice.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    return fixture;
  }

  it('creates a scoping question and queues a scope job', async () => {
    const { app, db, aliceCookie } = await withModules();
    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'How do I patch a krell?' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scoping');

    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'scope_question'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].question_id).toBe(res.body.id);
  });

  // A question awaiting review, with the fixture module linked as its scope.
  async function withScopedQuestion() {
    const fixture = await withModules();
    const { rows: modules } = await fixture.db.query(
      'SELECT rm.module_id AS id FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id WHERE r.user_id = $1',
      [fixture.alice.id]
    );
    const { rows: q } = await fixture.db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'scoped') RETURNING *`,
      [fixture.alice.id]
    );
    await fixture.db.query(
      'INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)',
      [q[0].id, modules[0].id]
    );
    return { ...fixture, moduleId: modules[0].id, question: q[0] };
  }

  it('offers review options: rack, components, documents, answers, notes', async () => {
    const { app, db, aliceCookie, alice, moduleId, question } = await withScopedQuestion();
    const other = await insertModule(db, alice.id, { manufacturer: '2hp', name: 'Pluck' });
    const { rows: jack } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'EOR')
       RETURNING id`,
      [moduleId]
    );
    await db.query(
      'INSERT INTO question_components (question_id, component_id) VALUES ($1, $2)',
      [question.id, jack[0].id]
    );
    const { rows: upload } = await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, name, source)
       VALUES ($1, $2, 'ffff', 'my notes', 'upload') RETURNING id`,
      [moduleId, alice.id]
    );
    const { rows: prev } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Earlier', 'A', 'answered', now()) RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      prev[0].id,
      moduleId,
    ]);
    // One note on the module, one only on the jack component.
    const { rows: moduleNote } = await db.query(
      `INSERT INTO notes (user_id, title, body) VALUES ($1, 'On module', 'x') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO note_modules (note_id, module_id) VALUES ($1, $2)', [
      moduleNote[0].id,
      moduleId,
    ]);
    const { rows: jackNote } = await db.query(
      `INSERT INTO notes (user_id, title, body) VALUES ($1, 'On jack', 'y') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO note_components (note_id, component_id) VALUES ($1, $2)', [
      jackNote[0].id,
      jack[0].id,
    ]);

    // Another user's upload must stay invisible.
    const { rows: admin } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, name, source)
       VALUES ($1, $2, 'eeee', 'theirs', 'upload')`,
      [moduleId, admin[0].id]
    );

    const res = await request(app)
      .get(`/api/questions/${question.id}/options`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);

    expect(res.body.modules).toHaveLength(2);
    const maths = res.body.modules.find((m) => m.name === 'Maths');
    expect(maths.in_scope).toBe(true);
    expect(res.body.modules.find((m) => m.name === 'Pluck').in_scope).toBe(false);

    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0]).toMatchObject({
      id: jack[0].id,
      module_id: moduleId,
      name: 'EOR',
      in_scope: true,
    });

    // The shared manual plus alice's upload; the admin's upload is hidden.
    expect(res.body.manuals).toHaveLength(2);
    expect(res.body.manuals.map((m) => m.name).sort()).toEqual(['manual', 'my notes']);
    expect(res.body.manuals.find((m) => m.id === upload[0].id).source).toBe('upload');

    expect(res.body.answers).toHaveLength(1);
    expect(res.body.answers[0]).toMatchObject({ id: prev[0].id, module_ids: [moduleId] });

    expect(res.body.notes).toHaveLength(2);
    const byTitle = Object.fromEntries(res.body.notes.map((n) => [n.title, n]));
    expect(byTitle['On module'].module_ids).toEqual([moduleId]);
    expect(byTitle['On jack'].component_ids).toEqual([jack[0].id]);
  });

  it('saves the reviewed selection and queues the answer job', async () => {
    const { app, db, aliceCookie, alice, moduleId, question } = await withScopedQuestion();
    const { rows: manual } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [
      moduleId,
    ]);
    const { rows: jack } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'EOR')
       RETURNING id`,
      [moduleId]
    );
    const { rows: note } = await db.query(
      `INSERT INTO notes (user_id, body) VALUES ($1, 'n') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO note_components (note_id, component_id) VALUES ($1, $2)', [
      note[0].id,
      jack[0].id,
    ]);

    const res = await request(app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', aliceCookie)
      .send({
        module_ids: [moduleId],
        component_ids: [jack[0].id],
        manual_ids: [manual[0].id],
        note_ids: [note[0].id],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'answer_question'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].question_id).toBe(question.id);
    const { rows: links } = await db.query(
      'SELECT * FROM question_manuals WHERE question_id = $1',
      [question.id]
    );
    expect(links.map((l) => l.manual_id)).toEqual([manual[0].id]);
    const { rows: componentLinks } = await db.query(
      'SELECT * FROM question_components WHERE question_id = $1',
      [question.id]
    );
    expect(componentLinks.map((l) => l.component_id)).toEqual([jack[0].id]);
    const { rows: noteLinks } = await db.query(
      'SELECT * FROM question_notes WHERE question_id = $1',
      [question.id]
    );
    expect(noteLinks.map((l) => l.note_id)).toEqual([note[0].id]);
  });

  it('rejects review submissions that fail validation', async () => {
    const { app, db, aliceCookie, alice, moduleId, question } = await withScopedQuestion();
    const { rows: manual } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [
      moduleId,
    ]);
    const post = (body) =>
      request(app).post(`/api/questions/${question.id}/answer`).set('Cookie', aliceCookie).send(body);

    // No modules selected.
    expect((await post({ module_ids: [], manual_ids: [manual[0].id] })).status).toBe(400);
    // No attachments selected at all.
    expect((await post({ module_ids: [moduleId] })).status).toBe(400);
    // A module that is not in alice's rack.
    const stranger = await insertModule(db, null, { manufacturer: 'X', name: 'Y' });
    expect(
      (await post({ module_ids: [stranger.id], manual_ids: [manual[0].id] })).status
    ).toBe(400);
    // Another user's uploaded document.
    const { rows: admin } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const { rows: foreign } = await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, name, source)
       VALUES ($1, $2, 'eeee', 'theirs', 'upload') RETURNING id`,
      [moduleId, admin[0].id]
    );
    expect(
      (await post({ module_ids: [moduleId], manual_ids: [foreign[0].id] })).status
    ).toBe(400);
    // A note not attached to any selected module or component.
    const { rows: looseNote } = await db.query(
      `INSERT INTO notes (user_id, body) VALUES ($1, 'loose') RETURNING id`,
      [alice.id]
    );
    expect(
      (
        await post({
          module_ids: [moduleId],
          manual_ids: [manual[0].id],
          note_ids: [looseNote[0].id],
        })
      ).status
    ).toBe(400);

    // Nothing was linked or queued by the failed attempts.
    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'answer_question'");
    expect(jobs).toHaveLength(0);
    const { rows: q } = await db.query('SELECT status FROM questions WHERE id = $1', [
      question.id,
    ]);
    expect(q[0].status).toBe('scoped');
  });

  it('only accepts review submissions for scoped questions', async () => {
    const { app, db, aliceCookie, moduleId, question } = await withScopedQuestion();
    await db.query(`UPDATE questions SET status = 'answered' WHERE id = $1`, [question.id]);
    const { rows: manual } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [
      moduleId,
    ]);
    const res = await request(app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', aliceCookie)
      .send({ module_ids: [moduleId], manual_ids: [manual[0].id] });
    expect(res.status).toBe(409);
  });

  it('refuses questions when no modules are imported', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Anything?' });
    expect(res.status).toBe(400);
  });

  it('requires a prompt', async () => {
    const { app, aliceCookie } = await withModules();
    expect(
      (await request(app).post('/api/questions').set('Cookie', aliceCookie).send({ prompt: '  ' }))
        .status
    ).toBe(400);
  });

  it('lists own questions newest first and shows detail with linked modules', async () => {
    const { app, db, aliceCookie, alice } = await withModules();
    const { rows: modules } = await db.query(
      'SELECT rm.module_id AS id FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id WHERE r.user_id = $1',
      [alice.id]
    );
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Old question', 'Old answer', 'answered', now()) RETURNING *`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      q[0].id,
      modules[0].id,
    ]);

    const list = await request(app).get('/api/questions').set('Cookie', aliceCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const detail = await request(app).get(`/api/questions/${q[0].id}`).set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.answer).toBe('Old answer');
    expect(detail.body.modules).toHaveLength(1);
    expect(detail.body.modules[0].name).toBe('Maths');
  });

  it('includes the specific jacks linked to a question', async () => {
    const { app, db, aliceCookie, alice } = await withModules();
    const { rows: modules } = await db.query(
      'SELECT rm.module_id AS id FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id WHERE r.user_id = $1',
      [alice.id]
    );
    const { rows: jack } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'EOR')
       RETURNING id`,
      [modules[0].id]
    );
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status) VALUES ($1, 'Q', 'A', 'answered')
       RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_components (question_id, component_id) VALUES ($1, $2)', [
      q[0].id,
      jack[0].id,
    ]);

    const res = await request(app).get(`/api/questions/${q[0].id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0]).toMatchObject({
      name: 'EOR',
      type: 'output_jack',
      module_manufacturer: 'Make Noise',
      module_name: 'Maths',
    });
  });

  it("hides other users' questions", async () => {
    const { app, db, adminCookie, alice } = await withModules();
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt) VALUES ($1, 'Private') RETURNING id`,
      [alice.id]
    );
    expect(
      (await request(app).get(`/api/questions/${q[0].id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
  });
});

describe('jobs API', () => {
  it('shows a user their own jobs and lets them retry failed ones', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status, error)
       VALUES ('find_manual', $1, $2, 'failed', 'boom') RETURNING *`,
      [rows[0].id, module.id]
    );

    const list = await request(app).get('/api/jobs').set('Cookie', aliceCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].module_name).toBe('Maths');

    const retry = await request(app)
      .post(`/api/jobs/${jobs[0].id}/retry`)
      .set('Cookie', aliceCookie);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('pending');
  });

  it("hides other users' jobs — even for a shared module — except from admins", async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status)
       VALUES ('find_manual', $1, $2, 'failed') RETURNING *`,
      [rows[0].id, module.id]
    );

    const adminList = await request(app).get('/api/jobs').set('Cookie', adminCookie);
    expect(adminList.body).toHaveLength(1);

    // bob even has the same shared module — still can't see alice's job.
    await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'bob', password: 'password123' });
    const bobLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'bob', password: 'password123' });
    const bobCookie = bobLogin.headers['set-cookie'][0].split(';')[0];
    const { rows: bob } = await db.query("SELECT id FROM users WHERE username = 'bob'");
    await mapModule(db, bob[0].id, module.id);

    const bobList = await request(app).get('/api/jobs').set('Cookie', bobCookie);
    expect(bobList.body).toHaveLength(0);
    expect(
      (await request(app).post(`/api/jobs/${jobs[0].id}/retry`).set('Cookie', bobCookie)).status
    ).toBe(404);
  });

  it('only retries failed jobs', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status)
       VALUES ('find_manual', $1, $2, 'pending') RETURNING *`,
      [rows[0].id, module.id]
    );
    expect(
      (await request(app).post(`/api/jobs/${jobs[0].id}/retry`).set('Cookie', aliceCookie)).status
    ).toBe(400);
  });

  it('stamps scope_question jobs with the asking user', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'How?' });
    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'scope_question'");
    expect(jobs[0].user_id).toBe(rows[0].id);
  });
});
