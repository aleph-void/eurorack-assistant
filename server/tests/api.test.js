import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, PDF_BYTES, PDF_HASH } from './helpers.js';

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
    await db.query('INSERT INTO user_modules (user_id, module_id) VALUES ($1, $2)', [
      admin[0].id,
      module.id,
    ]);
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
    expect(res.body.providers).toEqual(['claude', 'codex']);
    expect(res.body.known_models.claude).toContain('claude-fable-5');
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

  it('creates a pending question and queues an answer job', async () => {
    const { app, db, aliceCookie } = await withModules();
    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'How do I patch a krell?' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');

    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'answer_question'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].question_id).toBe(res.body.id);
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
      'SELECT module_id AS id FROM user_modules WHERE user_id = $1',
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
      'SELECT module_id AS id FROM user_modules WHERE user_id = $1',
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
    await db.query('INSERT INTO user_modules (user_id, module_id) VALUES ($1, $2)', [
      bob[0].id,
      module.id,
    ]);

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

  it('stamps answer_question jobs with the asking user', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'How?' });
    const { rows: jobs } = await db.query("SELECT * FROM jobs WHERE type = 'answer_question'");
    expect(jobs[0].user_id).toBe(rows[0].id);
  });
});
