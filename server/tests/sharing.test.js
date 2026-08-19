// Sharing: handing one of your records to somebody else to read, and the two
// halves that has to have — they can see it, and they still cannot touch it.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertManualText, insertModule, login, PDF_BYTES, PDF_HASH } from './helpers.js';

// alice, admin, and a third user (bob) who is in on nothing: the one who
// proves a share reaches exactly who it names.
async function withUsers() {
  const fixture = await createTestApp();
  const { db, app } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.admin = users.find((u) => u.username === 'admin');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.bob = await createUser(db, { username: 'bob' });
  fixture.bobCookie = await login(app, 'bob');
  return fixture;
}

const createNote = async (app, cookie, body = 'EOR into Signal In makes it cycle.') => {
  const res = await request(app).post('/api/notes').set('Cookie', cookie).send({ title: 'Krell', body });
  expect(res.status).toBe(201);
  return res.body;
};

// A patch of alice's, built the way the patch routes build one.
async function createPatch(fixture) {
  const { app, aliceCookie, db, alice } = fixture;
  const module = await insertModule(db, alice.id);
  const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
  const res = await request(app)
    .post('/api/patches')
    .set('Cookie', aliceCookie)
    .send({ rack_id: racks[0].id, name: 'Krell' });
  expect(res.status).toBe(201);
  return { patch: res.body, module, rackId: racks[0].id };
}

const share = (app, cookie, type, id, body) =>
  request(app).put(`/api/shares/${type}/${id}`).set('Cookie', cookie).send(body);

describe('managing shares', () => {
  it('lists the other users a share can be addressed to', async () => {
    const { app, aliceCookie } = await withUsers();
    const res = await request(app).get('/api/shares/users').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    // Everyone but alice herself — sharing with yourself is not a thing.
    expect(res.body.map((u) => u.username).sort()).toEqual(['admin', 'bob']);
  });

  it('shares a note with one named user, and nobody else', async () => {
    const { app, aliceCookie, adminCookie, bobCookie, admin } = await withUsers();
    const note = await createNote(app, aliceCookie);

    const saved = await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ everyone: false, label: 'Krell' });
    expect(saved.body.users).toEqual([{ id: admin.id, username: 'admin' }]);

    const seen = await request(app).get(`/api/notes/${note.id}`).set('Cookie', adminCookie);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ id: note.id, shared: true, owner_username: 'alice' });
    expect(seen.body.body).toContain('makes it cycle');

    expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', bobCookie)).status).toBe(404);
  });

  it('shares with every user at once', async () => {
    const { app, aliceCookie, adminCookie, bobCookie } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { everyone: true });

    for (const cookie of [adminCookie, bobCookie]) {
      expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', cookie)).status).toBe(200);
    }
  });

  // What "everyone" means: the people who are not users yet, too.
  it('reaches a user created after the share was made', async () => {
    const { app, aliceCookie, db } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { everyone: true });

    await createUser(db, { username: 'carol' });
    const carolCookie = await login(app, 'carol');
    expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', carolCookie)).status).toBe(200);
  });

  // Naming people and sharing with everyone are not exclusive: turning
  // "everyone" back off leaves the named ones where they were.
  it('keeps named recipients when the everyone share is withdrawn', async () => {
    const { app, aliceCookie, adminCookie, bobCookie, admin } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { everyone: true, user_ids: [admin.id] });

    const narrowed = await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });
    expect(narrowed.body).toMatchObject({ everyone: false });
    expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', bobCookie)).status).toBe(404);
  });

  it('stops sharing on request', async () => {
    const { app, aliceCookie, adminCookie, admin } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });

    const stopped = await request(app)
      .delete(`/api/shares/note/${note.id}`)
      .set('Cookie', aliceCookie);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ everyone: false, users: [] });
    expect((await request(app).get(`/api/notes/${note.id}`).set('Cookie', adminCookie)).status).toBe(404);
  });

  it('will not let anyone but the owner say who sees it', async () => {
    const { app, aliceCookie, adminCookie, bobCookie, bob } = await withUsers();
    const note = await createNote(app, aliceCookie);
    // Shared with admin — who still does not get to pass it on.
    await share(app, aliceCookie, 'note', note.id, { user_ids: [bob.id] });

    expect((await share(app, adminCookie, 'note', note.id, { everyone: true })).status).toBe(404);
    expect((await share(app, bobCookie, 'note', note.id, { everyone: true })).status).toBe(404);
    expect((await request(app).get(`/api/shares/note/${note.id}`).set('Cookie', bobCookie)).status).toBe(404);
  });

  it('rejects a type it cannot share and a user that does not exist', async () => {
    const { app, aliceCookie } = await withUsers();
    const note = await createNote(app, aliceCookie);
    const badType = await share(app, aliceCookie, 'capture', note.id, { everyone: true });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toContain('note, patch, question, rack, document');

    const badUser = await share(app, aliceCookie, 'note', note.id, { user_ids: [9999] });
    expect(badUser.status).toBe(400);
    expect(badUser.body.error).toContain('unknown user');
  });

  it('shows the owner who can see what, and the recipient what they have', async () => {
    const { app, aliceCookie, adminCookie, admin } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });

    const outgoing = await request(app).get('/api/shares/outgoing').set('Cookie', aliceCookie);
    expect(outgoing.body.notes).toEqual([
      { type: 'note', id: note.id, label: 'Krell', everyone: false, users: [{ id: admin.id, username: 'admin' }] },
    ]);

    const incoming = await request(app).get('/api/shares/incoming').set('Cookie', adminCookie);
    expect(incoming.body.notes).toHaveLength(1);
    expect(incoming.body.notes[0]).toMatchObject({
      type: 'note',
      id: note.id,
      label: 'Krell',
      owner_username: 'alice',
    });
    // The other kinds are present and empty, not missing.
    expect(incoming.body.patches).toEqual([]);
    expect(incoming.body.racks).toEqual([]);

    // Alice's own note is hers by owning it, not by a share.
    const own = await request(app).get('/api/shares/incoming').set('Cookie', aliceCookie);
    expect(own.body.notes).toEqual([]);
  });

  it('takes the share with the record when the record is deleted', async () => {
    const { app, aliceCookie, adminCookie, admin, db } = await withUsers();
    const note = await createNote(app, aliceCookie);
    await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });

    await request(app).delete(`/api/notes/${note.id}`).set('Cookie', aliceCookie);
    const { rows } = await db.query('SELECT * FROM shares');
    expect(rows).toHaveLength(0);
    const incoming = await request(app).get('/api/shares/incoming').set('Cookie', adminCookie);
    expect(incoming.body.notes).toEqual([]);
  });
});

describe('what a shared record lets you do', () => {
  it('reads a shared patch without being able to change it', async () => {
    const fixture = await withUsers();
    const { app, aliceCookie, adminCookie, admin } = fixture;
    const { patch } = await createPatch(fixture);
    await share(app, aliceCookie, 'patch', patch.id, { user_ids: [admin.id] });

    const read = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: patch.id, name: 'Krell', shared: true, owner_username: 'alice' });
    expect(Array.isArray(read.body.modules)).toBe(true);

    // Not in the recipient's own list, and not theirs to edit or delete.
    const list = await request(app).get('/api/patches').set('Cookie', adminCookie);
    expect(list.body).toEqual([]);
    const renamed = await request(app)
      .put(`/api/patches/${patch.id}`)
      .set('Cookie', adminCookie)
      .send({ name: 'mine now' });
    expect(renamed.status).toBe(404);
    expect((await request(app).delete(`/api/patches/${patch.id}`).set('Cookie', adminCookie)).status).toBe(404);
    // ...and it is still called what its owner called it.
    const after = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    expect(after.body.name).toBe('Krell');
    expect(after.body.shared).toBe(false);
  });

  it('reads a shared question and its answer', async () => {
    const { app, aliceCookie, adminCookie, admin, db, alice } = await withUsers();
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'How do I make it cycle?', 'Patch EOR into Signal In.', 'answered', now())
       RETURNING *`,
      [alice.id]
    );
    const question = rows[0];
    await share(app, aliceCookie, 'question', question.id, { user_ids: [admin.id] });

    const read = await request(app).get(`/api/questions/${question.id}`).set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      prompt: 'How do I make it cycle?',
      answer: 'Patch EOR into Signal In.',
      shared: true,
      owner_username: 'alice',
    });
    expect((await request(app).delete(`/api/questions/${question.id}`).set('Cookie', adminCookie)).status).toBe(404);
    expect((await request(app).get('/api/questions').set('Cookie', adminCookie)).body).toEqual([]);
  });

  it('reads a shared rack and what is in it', async () => {
    const { app, aliceCookie, adminCookie, bobCookie, db, alice, admin } = await withUsers();
    await insertModule(db, alice.id, { manufacturer: 'Make Noise', name: 'Maths' });
    await insertModule(db, alice.id, { manufacturer: 'ALM', name: 'Pam', quantity: 2 });
    const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
    const rackId = racks[0].id;
    await share(app, aliceCookie, 'rack', rackId, { user_ids: [admin.id] });

    const read = await request(app).get(`/api/racks/${rackId}`).set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ shared: true, owner_username: 'alice', module_count: 2 });
    expect(read.body.modules.map((m) => m.name)).toEqual(['Pam', 'Maths']);
    expect(read.body.modules.find((m) => m.name === 'Pam').quantity).toBe(2);

    // The rack list stays a list of your own racks.
    expect((await request(app).get('/api/racks').set('Cookie', adminCookie)).body).toEqual([]);
    expect((await request(app).get(`/api/racks/${rackId}`).set('Cookie', bobCookie)).status).toBe(404);
    // A shared rack is not a rack you can rename or delete.
    expect(
      (await request(app).put(`/api/racks/${rackId}`).set('Cookie', adminCookie).send({ name: 'x' })).status
    ).toBe(404);
  });

  it('reads a shared document: the PDF, its text, and in search', async () => {
    const { app, aliceCookie, adminCookie, bobCookie, db, alice, admin } = await withUsers();
    const module = await insertModule(db, alice.id);
    const upload = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({
        name: 'patch notes',
        filename: 'notes.pdf',
        data_base64: PDF_BYTES.toString('base64'),
      });
    expect(upload.status).toBe(201);
    const document = upload.body;
    expect(document.hash).toBe(PDF_HASH);
    // The extraction is a job in production; here the text is simply present.
    await insertManualText(db, { id: document.id, module_id: module.id, user_id: alice.id, hash: document.hash }, {
      title: 'patch notes',
      content: 'The wavefolder likes hot signals.',
    });

    // Private until shared.
    expect((await request(app).get(`/api/manuals/${document.hash}`).set('Cookie', adminCookie)).status).toBe(404);
    await share(app, aliceCookie, 'document', document.id, { user_ids: [admin.id] });

    const pdf = await request(app).get(`/api/manuals/${document.hash}`).set('Cookie', adminCookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = await request(app).get(`/api/manuals/${document.hash}/text`).set('Cookie', adminCookie);
    expect(text.status).toBe(200);
    expect(text.body.content).toContain('wavefolder');

    const found = await request(app).get('/api/manuals/search?q=wavefolder').set('Cookie', adminCookie);
    expect(found.body.results.map((r) => r.hash)).toEqual([document.hash]);
    // Still nobody else's business.
    expect((await request(app).get(`/api/manuals/${document.hash}/text`).set('Cookie', bobCookie)).status).toBe(404);
    expect((await request(app).get('/api/manuals/search?q=wavefolder').set('Cookie', bobCookie)).body.results).toEqual([]);
  });

  // A document shared with someone who has the same module belongs on that
  // module's page, credited to whoever handed it over.
  it('shows a shared document on the module page of whoever received it', async () => {
    const { app, aliceCookie, adminCookie, db, alice, admin } = await withUsers();
    const module = await insertModule(db, alice.id);
    await db.models.RackModule.create({
      rack_id: (await db.query('SELECT id FROM racks WHERE user_id = $1', [admin.id])).rows[0]?.id
        ?? (await db.models.Rack.create({ user_id: admin.id, name: 'main rack' })).id,
      module_id: module.id,
      quantity: 1,
    });
    const upload = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({ name: 'patch notes', filename: 'notes.pdf', data_base64: PDF_BYTES.toString('base64') });

    const before = await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie);
    expect(before.body.manuals).toEqual([]);

    await share(app, aliceCookie, 'document', upload.body.id, { user_ids: [admin.id] });
    const after = await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie);
    expect(after.body.manuals).toHaveLength(1);
    expect(after.body.manuals[0]).toMatchObject({ name: 'patch notes', shared_by: 'alice' });
    // Alice sees her own document as her own, with nobody to credit.
    const owners = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(owners.body.manuals[0].shared_by).toBe(null);
  });

  // The shared auto-found manual belongs to nobody, so there is nothing to
  // share: it is already readable by every user.
  it('refuses to share a document that is not an upload of yours', async () => {
    const { app, aliceCookie, db, alice } = await withUsers();
    const module = await insertModule(db, alice.id, { manual_hash: PDF_HASH });
    const { rows } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [module.id]);
    expect((await share(app, aliceCookie, 'document', rows[0].id, { everyone: true })).status).toBe(404);
  });
});

// A share hands over the record itself, not the owner's other private records
// that happen to be linked to it. Patches and captures are never shareable in
// their own right (a rack's physical layout only through a rack share), so
// none of them may ride out as an attachment on a note, question or patch.
describe('a share does not leak the owner\'s other private records', () => {
  it('hides a note\'s linked patches from the recipient but not the owner', async () => {
    const fixture = await withUsers();
    const { app, aliceCookie, adminCookie, admin } = fixture;
    const { patch } = await createPatch(fixture);
    const note = (
      await request(app)
        .post('/api/notes')
        .set('Cookie', aliceCookie)
        .send({ title: 'linked', body: 'see the patch', patch_ids: [patch.id] })
    ).body;
    expect(note.patches).toHaveLength(1);

    await share(app, aliceCookie, 'note', note.id, { user_ids: [admin.id] });

    const recipient = await request(app).get(`/api/notes/${note.id}`).set('Cookie', adminCookie);
    expect(recipient.status).toBe(200);
    expect(recipient.body.shared).toBe(true);
    expect(recipient.body.patches).toEqual([]);
    expect(recipient.body.captures).toEqual([]);

    // The owner still sees the whole note.
    const owner = await request(app).get(`/api/notes/${note.id}`).set('Cookie', aliceCookie);
    expect(owner.body.patches).toHaveLength(1);
  });

  it('hides a question\'s linked patches from the recipient but not the owner', async () => {
    const fixture = await withUsers();
    const { app, aliceCookie, adminCookie, admin, db, alice } = fixture;
    const { patch } = await createPatch(fixture);
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'q', 'a', 'answered', now()) RETURNING *`,
      [alice.id]
    );
    const question = rows[0];
    await db.query(
      'INSERT INTO question_patches (question_id, patch_id) VALUES ($1, $2)',
      [question.id, patch.id]
    );
    await share(app, aliceCookie, 'question', question.id, { user_ids: [admin.id] });

    const recipient = await request(app).get(`/api/questions/${question.id}`).set('Cookie', adminCookie);
    expect(recipient.status).toBe(200);
    expect(recipient.body.shared).toBe(true);
    expect(recipient.body.patches).toEqual([]);
    expect(recipient.body.notes).toEqual([]);
    expect(recipient.body.captures).toEqual([]);
    expect(recipient.body.manuals).toEqual([]);

    const owner = await request(app).get(`/api/questions/${question.id}`).set('Cookie', aliceCookie);
    expect(owner.body.patches).toHaveLength(1);
  });

  it('hides the rack layout behind a shared patch from the recipient but not the owner', async () => {
    const fixture = await withUsers();
    const { app, aliceCookie, adminCookie, admin, db } = fixture;
    const { patch, rackId } = await createPatch(fixture);
    // Give the rack a physical row so a layout exists to leak.
    await db.query(
      'INSERT INTO rack_rows (rack_id, position, unit, hp) VALUES ($1, 0, 3, 84)',
      [rackId]
    );
    await share(app, aliceCookie, 'patch', patch.id, { user_ids: [admin.id] });

    const recipient = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', adminCookie);
    expect(recipient.status).toBe(200);
    expect(recipient.body.shared).toBe(true);
    expect(recipient.body.rack_layout).toEqual([]);

    const owner = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    expect(owner.body.rack_layout.length).toBeGreaterThan(0);
  });
});
