import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertModule, login, PDF_HASH } from './helpers.js';

// The question flow's review step: what GET /:id/options offers and what
// POST /:id/answer accepts. The happy paths live in api.test.js; this file
// covers the capture branch of both, the patch attachments, and the
// validation that keeps foreign records out of a question's scope.

async function withModules() {
  const fixture = await createTestApp();
  const { rows } = await fixture.db.query("SELECT id FROM users WHERE username = 'alice'");
  fixture.alice = rows[0];
  fixture.module = await insertModule(fixture.db, fixture.alice.id, {
    manual_hash: PDF_HASH,
    manual_status: 'found',
  });
  const { rows: jack } = await fixture.db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'EOR')
     RETURNING id`,
    [fixture.module.id]
  );
  fixture.jack = jack[0];
  return fixture;
}

// A question awaiting review, scoped to the fixture module.
async function withScopedQuestion() {
  const fixture = await withModules();
  const { rows: q } = await fixture.db.query(
    `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'scoped') RETURNING *`,
    [fixture.alice.id]
  );
  await fixture.db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
    q[0].id,
    fixture.module.id,
  ]);
  fixture.question = q[0];
  return fixture;
}

async function createPatch(fixture, name = 'Krell') {
  const { rows: racks } = await fixture.db.query('SELECT id FROM racks WHERE user_id = $1', [
    fixture.alice.id,
  ]);
  const res = await request(fixture.app)
    .post('/api/patches')
    .set('Cookie', fixture.aliceCookie)
    .send({ rack_id: racks[0].id, name });
  expect(res.status).toBe(201);
  return res.body;
}

// A capture with one channel, inserted the way the scope route stores them.
async function insertCapture(db, userId, { patchId = null, componentId = null, title = null }) {
  const capture = await db.models.Capture.create({
    user_id: userId,
    patch_id: patchId,
    title,
    image_hash: 'a'.repeat(64),
  });
  await db.models.CaptureChannel.create({
    capture_id: capture.id,
    channel_index: 0,
    component_id: componentId,
    label: title,
  });
  return capture;
}

describe('asking about patches', () => {
  it('attaches several patches at question time and validates them', async () => {
    const fixture = await withModules();
    const { app, db, aliceCookie } = fixture;
    const first = await createPatch(fixture, 'Krell');
    const second = await createPatch(fixture, 'Drone');

    const foreign = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Why silent?', patch_ids: [first.id, 999999] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/patch_ids must be your patches/);

    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Why silent?', patch_ids: [first.id, second.id, second.id] });
    expect(res.status).toBe(201);
    const { rows: links } = await db.query(
      'SELECT patch_id FROM question_patches WHERE question_id = $1 ORDER BY patch_id',
      [res.body.id]
    );
    expect(links.map((l) => l.patch_id)).toEqual([first.id, second.id]);
  });
});

describe('asking about a module', () => {
  it('puts the module in scope at question time and refuses one that is not yours', async () => {
    const fixture = await withModules();
    const { app, db, aliceCookie } = fixture;

    const foreign = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Why so quiet?', module_ids: [fixture.module.id, 999999] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/module_ids must be modules in your racks/);

    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Why so quiet?', module_id: fixture.module.id });
    expect(res.status).toBe(201);
    const { rows: links } = await db.query(
      'SELECT module_id FROM question_modules WHERE question_id = $1',
      [res.body.id]
    );
    expect(links.map((l) => l.module_id)).toEqual([fixture.module.id]);
  });
});

describe('the questions of one record', () => {
  it('narrows the list to the module in scope, or to the attached patch', async () => {
    const fixture = await withScopedQuestion();
    const { app, db, alice, aliceCookie } = fixture;
    const patch = await createPatch(fixture);

    // A second question about neither, and a third attached to the patch.
    const { rows: other } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'Unrelated?', 'scoped')
       RETURNING id`,
      [alice.id]
    );
    const { rows: onPatch } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'Why silent?', 'scoped')
       RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_patches (question_id, patch_id) VALUES ($1, $2)', [
      onPatch[0].id,
      patch.id,
    ]);

    const all = await request(app).get('/api/questions').set('Cookie', aliceCookie);
    expect(all.body.map((q) => q.id).sort()).toEqual(
      [fixture.question.id, other[0].id, onPatch[0].id].sort()
    );

    const byModule = await request(app)
      .get(`/api/questions?module_id=${fixture.module.id}`)
      .set('Cookie', aliceCookie);
    expect(byModule.status).toBe(200);
    expect(byModule.body.map((q) => q.id)).toEqual([fixture.question.id]);

    const byPatch = await request(app)
      .get(`/api/questions?patch_id=${patch.id}`)
      .set('Cookie', aliceCookie);
    expect(byPatch.body.map((q) => q.id)).toEqual([onPatch[0].id]);

    // A record nothing has been asked about has an empty list, not everything.
    const none = await request(app)
      .get('/api/questions?module_id=999999')
      .set('Cookie', aliceCookie);
    expect(none.body).toEqual([]);

    // Somebody else's questions are not in either list.
    const admin = await request(app)
      .get(`/api/questions?module_id=${fixture.module.id}`)
      .set('Cookie', fixture.adminCookie);
    expect(admin.body).toEqual([]);
  });
});

describe('review options', () => {
  it('is only offered to the question owner', async () => {
    const fixture = await withScopedQuestion();
    const res = await request(fixture.app)
      .get(`/api/questions/${fixture.question.id}/options`)
      .set('Cookie', fixture.adminCookie);
    expect(res.status).toBe(404);
  });

  it('offers captures that watched a scoped jack or a patched module', async () => {
    const fixture = await withScopedQuestion();
    const { app, db, alice, aliceCookie } = fixture;
    const patch = await createPatch(fixture);

    // One capture pinned to a jack, one that only knows its patch, and one
    // that knows nothing — the last has no business in the options.
    const onJack = await insertCapture(db, alice.id, {
      componentId: fixture.jack.id,
      title: 'gate out',
    });
    const onPatch = await insertCapture(db, alice.id, { patchId: patch.id, title: 'the patch' });
    await insertCapture(db, alice.id, { title: 'a mystery' });

    const res = await request(app)
      .get(`/api/questions/${fixture.question.id}/options`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.captures.map((c) => c.id)).toEqual([onPatch.id, onJack.id]);
    expect(res.body.captures.find((c) => c.id === onJack.id)).toMatchObject({
      module_ids: [fixture.module.id],
      component_ids: [fixture.jack.id],
      channel_count: 1,
    });
    // The patch-only capture reaches its modules through the patch snapshot.
    expect(res.body.captures.find((c) => c.id === onPatch.id)).toMatchObject({
      module_ids: [fixture.module.id],
      component_ids: [],
    });
    // The patch itself is offered, not yet attached, with its modules.
    expect(res.body.patches).toEqual([
      expect.objectContaining({ id: patch.id, name: 'Krell', attached: false, module_ids: [] }),
    ]);
  });

  it('offers an answered question reachable only through a component', async () => {
    const fixture = await withScopedQuestion();
    const { app, db, alice, aliceCookie } = fixture;
    const { rows: prev } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Earlier', 'A', 'answered', now()) RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_components (question_id, component_id) VALUES ($1, $2)', [
      prev[0].id,
      fixture.jack.id,
    ]);

    const res = await request(app)
      .get(`/api/questions/${fixture.question.id}/options`)
      .set('Cookie', aliceCookie);
    expect(res.body.answers).toEqual([
      expect.objectContaining({
        id: prev[0].id,
        module_ids: [],
        component_ids: [fixture.jack.id],
      }),
    ]);
  });

  it('answers an empty rack with empty options rather than an error', async () => {
    const fixture = await createTestApp();
    const { app, db } = fixture;
    const bob = await createUser(db, { username: 'bob' });
    const bobCookie = await login(app, 'bob');
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'How?', 'scoped') RETURNING id`,
      [bob.id]
    );
    const res = await request(app).get(`/api/questions/${q[0].id}/options`).set('Cookie', bobCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      modules: [],
      components: [],
      manuals: [],
      answers: [],
      notes: [],
      captures: [],
      patches: [],
    });
  });
});

describe('confirming the review', () => {
  const answer = (fixture, body, questionId = fixture.question.id) =>
    request(fixture.app)
      .post(`/api/questions/${questionId}/answer`)
      .set('Cookie', fixture.aliceCookie)
      .send(body);

  it('rejects attachments that are not yours or not about the selection', async () => {
    const fixture = await withScopedQuestion();
    const { db, alice } = fixture;
    const moduleIds = [fixture.module.id];

    expect((await answer(fixture, { module_ids: moduleIds }, 999999)).status).toBe(404);

    // A jack on a module outside the selection.
    const other = await insertModule(db, alice.id, { manufacturer: '2hp', name: 'Pluck' });
    const { rows: otherJack } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'IN')
       RETURNING id`,
      [other.id]
    );
    const badComponent = await answer(fixture, {
      module_ids: moduleIds,
      component_ids: [otherJack[0].id],
    });
    expect(badComponent.status).toBe(400);
    expect(badComponent.body.error).toMatch(/components of the selected modules/);

    // Previous answers: not answered, and answered about something else.
    const notAnswered = await answer(fixture, {
      module_ids: moduleIds,
      answer_ids: [fixture.question.id],
    });
    expect(notAnswered.status).toBe(400);
    expect(notAnswered.body.error).toMatch(/your answered questions/);
    const { rows: elsewhere } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'About Pluck', 'A', 'answered', now()) RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      elsewhere[0].id,
      other.id,
    ]);
    const unrelatedAnswer = await answer(fixture, {
      module_ids: moduleIds,
      answer_ids: [elsewhere[0].id],
    });
    expect(unrelatedAnswer.status).toBe(400);
    expect(unrelatedAnswer.body.error).toMatch(/about the selected modules or components/);

    // Notes: someone else's, then yours but about an unselected module.
    const { rows: admin } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const { rows: theirNote } = await db.query(
      `INSERT INTO notes (user_id, title, body) VALUES ($1, 'theirs', 'x') RETURNING id`,
      [admin[0].id]
    );
    const foreignNote = await answer(fixture, {
      module_ids: moduleIds,
      note_ids: [theirNote[0].id],
    });
    expect(foreignNote.status).toBe(400);
    expect(foreignNote.body.error).toMatch(/your notes/);
    const { rows: pluckNote } = await db.query(
      `INSERT INTO notes (user_id, title, body) VALUES ($1, 'pluck', 'x') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO note_modules (note_id, module_id) VALUES ($1, $2)', [
      pluckNote[0].id,
      other.id,
    ]);
    const unrelatedNote = await answer(fixture, {
      module_ids: moduleIds,
      note_ids: [pluckNote[0].id],
    });
    expect(unrelatedNote.status).toBe(400);
    expect(unrelatedNote.body.error).toMatch(/notes attached to the selected/);

    // Captures: someone else's, then yours of an unselected jack.
    const theirCapture = await insertCapture(db, admin[0].id, { componentId: fixture.jack.id });
    const foreignCapture = await answer(fixture, {
      module_ids: moduleIds,
      capture_ids: [theirCapture.id],
    });
    expect(foreignCapture.status).toBe(400);
    expect(foreignCapture.body.error).toMatch(/your captures/);
    const pluckCapture = await insertCapture(db, alice.id, { componentId: otherJack[0].id });
    const unrelatedCapture = await answer(fixture, {
      module_ids: moduleIds,
      capture_ids: [pluckCapture.id],
    });
    expect(unrelatedCapture.status).toBe(400);
    expect(unrelatedCapture.body.error).toMatch(/captures of the selected/);

    // Patches: only your own can be attached.
    const foreignPatch = await answer(fixture, { module_ids: moduleIds, patch_ids: [999999] });
    expect(foreignPatch.status).toBe(400);
    expect(foreignPatch.body.error).toMatch(/patch_ids must be your patches/);

    // module_ids that are not an array of positive integers select nothing.
    const garbage = await answer(fixture, { module_ids: 'all of them' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toMatch(/at least one module/);
  });

  it('saves a capture and a previous answer with the scope and queues the job', async () => {
    const fixture = await withScopedQuestion();
    const { db, alice } = fixture;
    const { rows: prev } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Earlier', 'A', 'answered', now()) RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      prev[0].id,
      fixture.module.id,
    ]);
    const capture = await insertCapture(db, alice.id, { componentId: fixture.jack.id });

    // Duplicates, fractions and negatives are cleaned out, not rejected.
    const res = await answer(fixture, {
      module_ids: [fixture.module.id, fixture.module.id, -4, 1.5],
      component_ids: [fixture.jack.id],
      answer_ids: [prev[0].id],
      capture_ids: [capture.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    const { rows: moduleLinks } = await db.query(
      'SELECT module_id FROM question_modules WHERE question_id = $1',
      [fixture.question.id]
    );
    expect(moduleLinks).toEqual([{ module_id: fixture.module.id }]);
    const { rows: answerLinks } = await db.query(
      'SELECT source_question_id FROM question_answers WHERE question_id = $1',
      [fixture.question.id]
    );
    expect(answerLinks).toEqual([{ source_question_id: prev[0].id }]);
    const { rows: captureLinks } = await db.query(
      'SELECT capture_id FROM question_captures WHERE question_id = $1',
      [fixture.question.id]
    );
    expect(captureLinks).toEqual([{ capture_id: capture.id }]);
    const { rows: jobs } = await db.query(
      "SELECT question_id FROM jobs WHERE type = 'answer_question'"
    );
    expect(jobs).toEqual([{ question_id: fixture.question.id }]);
  });
});
