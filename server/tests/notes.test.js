import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule } from './helpers.js';

// Fixture: alice has a module with two components; admin has their own module.
async function withNotesFixture() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.admin = users.find((u) => u.username === 'admin');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.module = await insertModule(db, fixture.alice.id);
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'input_jack', 'Signal In'), ($1, 'output_jack', 'EOR') RETURNING *`,
    [fixture.module.id]
  );
  fixture.components = components;
  fixture.adminModule = await insertModule(db, fixture.admin.id, {
    manufacturer: 'ALM',
    name: 'Pam',
  });
  return fixture;
}

describe('notes API', () => {
  it('creates a note attached to a module and a component', async () => {
    const { app, aliceCookie, module, components } = await withNotesFixture();
    const res = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({
        title: 'Krell patch',
        body: 'EOR into Signal In makes it cycle.',
        module_ids: [module.id],
        component_ids: [components[1].id],
      });
    expect(res.status).toBe(201);
    expect(res.body.modules).toHaveLength(1);
    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0].name).toBe('EOR');
  });

  it('requires a body and validates attachment ownership', async () => {
    const { app, aliceCookie, adminModule } = await withNotesFixture();
    expect(
      (await request(app).post('/api/notes').set('Cookie', aliceCookie).send({ body: '  ' })).status
    ).toBe(400);
    // Alice cannot attach to a module that is not in her system.
    const res = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'x', module_ids: [adminModule.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in your system/);
  });

  it('attaches an existing note to additional modules and components', async () => {
    const { app, db, aliceCookie, alice, module, components } = await withNotesFixture();
    const second = await insertModule(db, alice.id, {
      manufacturer: 'Mutable Instruments',
      name: 'Beads',
    });

    const created = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'Reusable note', module_ids: [module.id] });

    const res = await request(app)
      .post(`/api/notes/${created.body.id}/attach`)
      .set('Cookie', aliceCookie)
      .send({ module_ids: [second.id, module.id], component_ids: [components[0].id] });
    expect(res.status).toBe(200);
    expect(res.body.modules.map((m) => m.name).sort()).toEqual(['Beads', 'Maths']);
    expect(res.body.components).toHaveLength(1);

    // Re-attaching is idempotent.
    const { rows } = await db.query('SELECT * FROM note_modules WHERE note_id = $1', [
      created.body.id,
    ]);
    expect(rows).toHaveLength(2);
  });

  it('detaches from a module without deleting the note', async () => {
    const { app, aliceCookie, module, components } = await withNotesFixture();
    const created = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'n', module_ids: [module.id], component_ids: [components[0].id] });

    const res = await request(app)
      .post(`/api/notes/${created.body.id}/detach`)
      .set('Cookie', aliceCookie)
      .send({ module_id: module.id });
    expect(res.status).toBe(200);
    expect(res.body.modules).toHaveLength(0);
    expect(res.body.components).toHaveLength(1);
  });

  it('updates and deletes own notes', async () => {
    const { app, aliceCookie } = await withNotesFixture();
    const created = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'draft' });

    const updated = await request(app)
      .put(`/api/notes/${created.body.id}`)
      .set('Cookie', aliceCookie)
      .send({ body: 'final', title: 'Named' });
    expect(updated.status).toBe(200);
    expect(updated.body.body).toBe('final');
    expect(updated.body.title).toBe('Named');

    expect(
      (await request(app).delete(`/api/notes/${created.body.id}`).set('Cookie', aliceCookie))
        .status
    ).toBe(200);
    const list = await request(app).get('/api/notes').set('Cookie', aliceCookie);
    expect(list.body).toHaveLength(0);
  });

  it("keeps notes strictly private: other users can't see or touch them", async () => {
    const { app, aliceCookie, adminCookie, module } = await withNotesFixture();
    const created = await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'private to alice', module_ids: [module.id] });
    const id = created.body.id;

    // Not in the other user's list, not readable, not modifiable.
    const adminList = await request(app).get('/api/notes').set('Cookie', adminCookie);
    expect(adminList.body).toHaveLength(0);
    expect(
      (await request(app).put(`/api/notes/${id}`).set('Cookie', adminCookie).send({ body: 'x' }))
        .status
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/notes/${id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/notes/${id}/attach`)
          .set('Cookie', adminCookie)
          .send({ module_ids: [module.id] })
      ).status
    ).toBe(404);
  });

  it('surfaces the user’s notes (module + component level) in module detail only for them', async () => {
    const { app, db, aliceCookie, adminCookie, admin, module, components } =
      await withNotesFixture();
    await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'module-level note', module_ids: [module.id] });
    await request(app)
      .post('/api/notes')
      .set('Cookie', aliceCookie)
      .send({ body: 'jack-level note', component_ids: [components[1].id] });

    const detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.notes).toHaveLength(2);
    const componentNote = detail.body.notes.find((n) => n.component_id !== null);
    expect(componentNote.body).toBe('jack-level note');
    expect(componentNote.component_id).toBe(components[1].id);

    // Admin also maps the shared module — but must not see alice's notes.
    await mapModule(db, admin.id, module.id);
    const adminDetail = await request(app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', adminCookie);
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.notes).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const { app } = await withNotesFixture();
    expect((await request(app).get('/api/notes')).status).toBe(401);
  });
});
