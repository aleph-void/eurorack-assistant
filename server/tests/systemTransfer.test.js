import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertModule, login } from './helpers.js';
import { freeName } from '../src/services/systemTransfer.js';

// An admin hands a whole system to another user: the racks, the patches made
// from it, and everything the old owner wrote about any of those.
describe('transferring a system', () => {
  async function userId(db, username) {
    const { rows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    return rows[0].id;
  }

  // Alice: a system of two racks (Maths in the left case, Plaits in the
  // right), plus a 'bench' rack outside the system that ALSO holds Plaits. A
  // system patch and a left-case patch, notes and questions about each kind
  // of thing, and a share. Bob: a system, a rack and a patch whose names
  // collide with Alice's.
  async function studio() {
    const fixture = await createTestApp();
    const { app, db, aliceCookie } = fixture;
    await createUser(db, { username: 'bob' });
    const bobCookie = await login(app, 'bob');
    const alice = await userId(db, 'alice');
    const bob = await userId(db, 'bob');

    const maths = await insertModule(db, alice, { name: 'Maths', rack: 'left case', hp: 20 });
    const plaits = await insertModule(db, alice, {
      manufacturer: 'Mutable',
      name: 'Plaits',
      rack: 'right case',
      hp: 12,
    });
    // Plaits also stands on Alice's bench, outside the system.
    const bench = await db.models.Rack.create({ user_id: alice, name: 'bench' });
    await db.models.RackModule.create({ rack_id: bench.id, module_id: plaits.id, quantity: 1 });

    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const leftRack = racks.find((r) => r.name === 'left case');
    const rightRack = racks.find((r) => r.name === 'right case');
    const system = (
      await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'studio' })
    ).body;
    for (const rack of [leftRack, rightRack]) {
      await request(app)
        .put(`/api/racks/${rack.id}/system`)
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id });
    }

    const systemPatch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Whole studio' })
    ).body;
    const rackPatch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: leftRack.id, name: 'Left only' })
    ).body;

    const post = (path, body) => request(app).post(path).set('Cookie', aliceCookie).send(body);
    const mathsNote = (await post('/api/notes', { body: 'maths note', module_ids: [maths.id] })).body;
    const plaitsNote = (await post('/api/notes', { body: 'plaits note', module_ids: [plaits.id] })).body;
    const patchNote = (await post('/api/notes', { body: 'patch note', patch_ids: [systemPatch.id] })).body;
    const freeNote = (await post('/api/notes', { body: 'about nothing' })).body;

    const systemQuestion = (
      await post('/api/questions', { prompt: 'what is this studio missing?', system_ids: [system.id] })
    ).body;
    const mathsQuestion = (
      await post('/api/questions', { prompt: 'why is maths quiet?', module_ids: [maths.id] })
    ).body;
    const plaitsQuestion = (
      await post('/api/questions', { prompt: 'plaits model?', module_ids: [plaits.id] })
    ).body;
    // A thread under the system question, and a note attached to it that
    // will NOT move (it is about Plaits, which Alice keeps on the bench).
    await db.models.Question.update({ status: 'answered', answer: 'a filter' }, { where: { id: systemQuestion.id } });
    const followUp = (
      await post(`/api/questions/${systemQuestion.id}/followups`, { prompt: 'which one?' })
    ).body;
    await db.models.QuestionNote.create({ question_id: systemQuestion.id, note_id: plaitsNote.id });
    await db.models.QuestionNote.create({ question_id: systemQuestion.id, note_id: mathsNote.id });

    await db.models.ResourceLink.create({ user_id: alice, system_id: system.id, url: 'https://a.test/' });
    await db.models.ResourceLink.create({ user_id: alice, module_id: plaits.id, url: 'https://b.test/' });
    await db.models.Share.create({ resource_type: 'patch', resource_id: systemPatch.id, owner_id: alice, user_id: bob });
    await db.models.Share.create({ resource_type: 'patch', resource_id: systemPatch.id, owner_id: alice, user_id: null });

    // Bob's own records, named to collide.
    await request(app).post('/api/systems').set('Cookie', bobCookie).send({ name: 'Studio' });
    // Module records are shared: Bob racks the same Maths in a case of his own.
    const bobLeft = await db.models.Rack.create({ user_id: bob, name: 'left case' });
    await db.models.RackModule.create({ rack_id: bobLeft.id, module_id: maths.id, quantity: 1 });
    await request(app)
      .post('/api/patches')
      .set('Cookie', bobCookie)
      .send({ rack_id: bobLeft.id, name: 'Whole studio' });

    return {
      ...fixture,
      bobCookie,
      alice,
      bob,
      maths,
      plaits,
      bench,
      leftRack,
      rightRack,
      system,
      systemPatch,
      rackPatch,
      mathsNote,
      plaitsNote,
      patchNote,
      freeNote,
      systemQuestion,
      mathsQuestion,
      plaitsQuestion,
      followUp,
    };
  }

  it('is the admin\'s alone, and only onto another user', async () => {
    const f = await studio();
    const { app, aliceCookie, adminCookie, system, alice, bob } = f;
    expect(
      (await request(app).post(`/api/systems/${system.id}/transfer`).set('Cookie', aliceCookie).send({ user_id: bob }))
        .status
    ).toBe(403);
    expect(
      (await request(app).post(`/api/systems/${system.id}/transfer`).set('Cookie', adminCookie).send({}))
        .status
    ).toBe(400);
    expect(
      (await request(app).post(`/api/systems/${system.id}/transfer`).set('Cookie', adminCookie).send({ user_id: alice }))
        .status
    ).toBe(400);
    expect(
      (await request(app).post(`/api/systems/${system.id}/transfer`).set('Cookie', adminCookie).send({ user_id: 99999 }))
        .status
    ).toBe(404);
    expect(
      (await request(app).post('/api/systems/99999/transfer').set('Cookie', adminCookie).send({ user_id: bob }))
        .status
    ).toBe(404);
    // Nothing moved.
    expect((await request(app).get('/api/systems').set('Cookie', aliceCookie)).body).toHaveLength(1);
  });

  it('lists a user\'s systems with what hangs off each, for the admin', async () => {
    const { app, adminCookie, aliceCookie, alice, system } = await studio();
    expect((await request(app).get(`/api/users/${alice}/systems`).set('Cookie', aliceCookie)).status).toBe(403);
    const res = await request(app).get(`/api/users/${alice}/systems`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: system.id, name: 'studio', rack_count: 2, module_count: 2, patch_count: 2 },
    ]);
    expect((await request(app).get('/api/users/99999/systems').set('Cookie', adminCookie)).status).toBe(404);
  });

  it('moves the system, its racks, its patches and what was written about them', async () => {
    const f = await studio();
    const { app, db, adminCookie, aliceCookie, bobCookie, alice, bob, system } = f;

    const res = await request(app)
      .post(`/api/systems/${system.id}/transfer`)
      .set('Cookie', adminCookie)
      .send({ user_id: bob });
    expect(res.status).toBe(200);
    expect(res.body.from).toMatchObject({ id: alice, username: 'alice' });
    expect(res.body.to).toMatchObject({ id: bob, username: 'bob' });
    expect(res.body.moved).toMatchObject({
      racks: 2,
      // Plaits also stands on Alice's bench, so only Maths is the system's alone.
      modules: 1,
      patches: 2,
      // The Maths note and the patch note; the Plaits note and the free note stay.
      notes: 2,
      // The system question, its follow-up and the Maths question.
      questions: 3,
      links: 1,
      // The share with Bob is spent; the share with everyone is re-owned.
      shares: 2,
    });
    expect(res.body.kept_modules).toBe(1);
    // Bob already had a 'Studio', a 'left case' and a 'Whole studio'.
    expect(res.body.renamed).toEqual([
      { kind: 'system', id: system.id, from: 'studio', to: 'studio 2' },
      { kind: 'rack', id: f.leftRack.id, from: 'left case', to: 'left case 2' },
      { kind: 'patch', id: f.systemPatch.id, from: 'Whole studio', to: 'Whole studio 2' },
    ]);
    expect(res.body.system).toEqual({ id: system.id, name: 'studio 2' });

    // The system and its racks are Bob's; Alice keeps the bench.
    expect((await request(app).get('/api/systems').set('Cookie', aliceCookie)).body).toEqual([]);
    const bobSystems = (await request(app).get('/api/systems').set('Cookie', bobCookie)).body;
    expect(bobSystems.map((s) => [s.name, s.rack_count])).toEqual([
      ['Studio', 0],
      ['studio 2', 2],
    ]);
    expect((await request(app).get('/api/racks').set('Cookie', aliceCookie)).body.map((r) => r.name)).toEqual([
      'bench',
    ]);
    const bobRacks = (await request(app).get('/api/racks').set('Cookie', bobCookie)).body;
    expect(bobRacks.map((r) => r.name).sort()).toEqual(['left case', 'left case 2', 'right case']);
    expect(bobRacks.find((r) => r.name === 'left case 2').system_id).toBe(system.id);

    // Both patches, with their snapshot names following the renames.
    expect((await request(app).get('/api/patches').set('Cookie', aliceCookie)).body.patches).toEqual([]);
    const bobPatches = (await request(app).get('/api/patches').set('Cookie', bobCookie)).body.patches;
    const moved = bobPatches.find((p) => p.id === f.systemPatch.id);
    expect(moved).toMatchObject({ name: 'Whole studio 2', system_id: system.id, system_name: 'studio 2' });
    expect(bobPatches.find((p) => p.id === f.rackPatch.id)).toMatchObject({
      name: 'Left only',
      rack_id: f.leftRack.id,
      rack_name: 'left case 2',
    });
    const detail = await request(app).get(`/api/patches/${f.systemPatch.id}`).set('Cookie', bobCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.modules).toHaveLength(2);

    // Notes: about Maths and about the patch → Bob; about Plaits, about nothing → Alice.
    const aliceNotes = (await request(app).get('/api/notes').set('Cookie', aliceCookie)).body.map((n) => n.id).sort();
    const bobNotes = (await request(app).get('/api/notes').set('Cookie', bobCookie)).body.map((n) => n.id).sort();
    expect(aliceNotes).toEqual([f.plaitsNote.id, f.freeNote.id].sort());
    expect(bobNotes).toEqual([f.mathsNote.id, f.patchNote.id].sort());

    // Questions: the system's (with its thread) and Maths's → Bob; Plaits's → Alice.
    const aliceQuestions = (await request(app).get('/api/questions').set('Cookie', aliceCookie)).body.map((q) => q.id);
    expect(aliceQuestions).toEqual([f.plaitsQuestion.id]);
    const bobQuestions = (await request(app).get('/api/questions').set('Cookie', bobCookie)).body.map((q) => q.id).sort();
    expect(bobQuestions).toEqual([f.systemQuestion.id, f.mathsQuestion.id].sort());
    const thread = await request(app).get(`/api/questions/${f.systemQuestion.id}`).set('Cookie', bobCookie);
    expect(thread.status).toBe(200);
    expect(thread.body.thread.map((t) => t.id)).toContain(f.followUp.id);
    // The attached Maths note came along; the attached Plaits note, which
    // stayed Alice's, was cut from the question.
    const attached = await db.models.QuestionNote.findAll({ where: { question_id: f.systemQuestion.id } });
    expect(attached.map((l) => l.note_id)).toEqual([f.mathsNote.id]);
    // The system's questions are listed under it for its new owner.
    const bySystem = await request(app).get(`/api/questions?system_id=${system.id}`).set('Cookie', bobCookie);
    expect(bySystem.body.map((q) => q.id)).toEqual([f.systemQuestion.id]);
    // The jobs of the moved questions run on Bob's account now.
    const jobs = await db.models.Job.findAll({ where: { question_id: [f.systemQuestion.id, f.followUp.id] } });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.user_id === bob)).toBe(true);

    // Links: the system's → Bob; the one on Plaits stays.
    const links = await db.models.ResourceLink.findAll({ order: [['id', 'ASC']] });
    expect(links.map((l) => l.user_id)).toEqual([bob, alice]);

    // Shares: the one with Bob is gone, the one with everyone is Bob's.
    const shares = await db.models.Share.findAll({ where: { resource_type: 'patch', resource_id: f.systemPatch.id } });
    expect(shares.map((s) => [s.owner_id, s.user_id])).toEqual([[bob, null]]);

    // Alice can no longer reach any of it — the patch Bob now shares with
    // everyone she may read like anyone else, but not touch.
    const asAlice = await request(app).get(`/api/patches/${f.systemPatch.id}`).set('Cookie', aliceCookie);
    expect(asAlice.status).toBe(200);
    expect(asAlice.body.shared).toBeTruthy();
    expect(
      (await request(app).put(`/api/patches/${f.systemPatch.id}`).set('Cookie', aliceCookie).send({ name: 'mine' }))
        .status
    ).toBe(404);
    expect((await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie)).status).toBe(404);
    expect((await request(app).get(`/api/questions/${f.systemQuestion.id}`).set('Cookie', aliceCookie)).status).toBe(404);
    // Bob still sees Alice's bench nowhere.
    expect((await request(app).get(`/api/racks/${f.bench.id}`).set('Cookie', bobCookie)).status).toBe(404);
  });

  it('moves a composition only when every patch it is mapped onto goes', async () => {
    const f = await studio();
    const { app, adminCookie, aliceCookie, bobCookie, bob, system, alice } = f;
    // A composition on the system patch alone, and one straddling the system
    // patch and a patch of the bench.
    const benchPatch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: f.bench.id, name: 'Bench' })
    ).body;
    const piece = (
      await request(app).post('/api/compositions').set('Cookie', aliceCookie).send({ name: 'Piece' })
    ).body;
    const straddler = (
      await request(app).post('/api/compositions').set('Cookie', aliceCookie).send({ name: 'Both' })
    ).body;
    for (const [compositionId, patchId] of [
      [piece.id, f.systemPatch.id],
      [straddler.id, f.systemPatch.id],
      [straddler.id, benchPatch.id],
    ]) {
      const paired = await request(app)
        .post(`/api/compositions/${compositionId}/patches`)
        .set('Cookie', aliceCookie)
        .send({ patch_id: patchId });
      expect(paired.status).toBe(201);
    }
    const res = await request(app)
      .post(`/api/systems/${system.id}/transfer`)
      .set('Cookie', adminCookie)
      .send({ user_id: bob });
    expect(res.status).toBe(200);
    expect(res.body.moved.compositions).toBe(1);
    const names = async (cookie) =>
      (await request(app).get('/api/compositions').set('Cookie', cookie)).body.compositions.map((c) => c.name);
    expect(await names(bobCookie)).toEqual(['Piece']);
    expect(await names(aliceCookie)).toEqual(['Both']);
    expect((await request(app).get('/api/patches').set('Cookie', aliceCookie)).body.patches.map((p) => p.name)).toEqual([
      'Bench',
    ]);
    expect(alice).not.toBe(bob);
  });

  it('hands out the next free name, ignoring case', () => {
    const taken = new Set(['studio', 'studio 2']);
    expect(freeName(taken, 'Studio')).toBe('Studio 3');
    expect(freeName(taken, 'desk')).toBe('desk');
    expect(freeName(new Set(), 'studio')).toBe('studio');
  });
});
