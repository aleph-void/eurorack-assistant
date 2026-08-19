import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule, PDF_BYTES, PDF_HASH } from './helpers.js';
import { manualPath } from '../src/services/pdf.js';

describe('racks API', () => {
  it('lists only the current user’s racks with module counts', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');
    const module = await insertModule(db, alice.id); // creates alice's 'main rack'
    await mapModule(db, alice.id, module.id, { rack: 'travel case' });
    await insertModule(db, admin.id, { manufacturer: 'ALM', name: 'Pam' });

    const res = await request(app).get('/api/racks').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => [r.name, r.module_count])).toEqual([
      ['main rack', 1],
      ['travel case', 1],
    ]);

    const adminRes = await request(app).get('/api/racks').set('Cookie', adminCookie);
    expect(adminRes.body.map((r) => r.name)).toEqual(['main rack']);
  });

  it('creates and renames racks, rejecting duplicate names per user', async () => {
    const { app, aliceCookie, adminCookie } = await createTestApp();
    const created = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .send({ name: 'studio' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('studio');

    // Same name (case-insensitively) is rejected for the same user…
    expect(
      (await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'Studio' }))
        .status
    ).toBe(409);
    // …but another user can reuse it.
    expect(
      (await request(app).post('/api/racks').set('Cookie', adminCookie).send({ name: 'studio' }))
        .status
    ).toBe(201);

    const second = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .send({ name: 'live case' });
    const renamed = await request(app)
      .put(`/api/racks/${second.body.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'STUDIO' });
    expect(renamed.status).toBe(409);
    // Renaming a rack to (a different casing of) its own name is fine.
    expect(
      (
        await request(app)
          .put(`/api/racks/${second.body.id}`)
          .set('Cookie', aliceCookie)
          .send({ name: 'Live Case' })
      ).status
    ).toBe(200);
    expect(
      (await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: '  ' })).status
    ).toBe(400);
  });

  it('stores 3U and 1U row layouts, bounded by each row’s HP', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id, { manufacturer: '2hp', name: 'ARP' });
    await db.query('UPDATE modules SET hp = 2 WHERE id = $1', [module.id]);
    await db.query(
      `INSERT INTO module_panels (module_id, image_hash, image_ext, width, height)
       VALUES ($1, 'arp-panel', 'svg', 80, 400)`,
      [module.id]
    );
    const rackId = module.rack_id;

    const saved = await request(app)
      .put(`/api/racks/${rackId}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        rows: [
          { unit: 3, hp: 84, modules: [{ module_id: module.id }] },
          { unit: 1, hp: 104, modules: [] },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.rows).toMatchObject([
      { unit: 3, hp: 84, modules: [{ module_id: module.id, hp: 2, panel: { url: '/api/panels/arp-panel.svg' } }] },
      { unit: 1, hp: 104, modules: [] },
    ]);

    const detail = await request(app).get(`/api/racks/${rackId}`).set('Cookie', aliceCookie);
    expect(detail.body.rows.map((row) => row.unit)).toEqual([3, 1]);
    const overfull = await request(app)
      .put(`/api/racks/${rackId}/layout`)
      .set('Cookie', aliceCookie)
      .send({ rows: [{ unit: 3, hp: 1, modules: [{ module_id: module.id }] }] });
    expect(overfull.status).toBe(400);
  });

  it('never exposes or mutates another user’s racks', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const list = await request(app).get('/api/racks').set('Cookie', aliceCookie);
    const rackId = list.body[0].id;

    expect(
      (await request(app).put(`/api/racks/${rackId}`).set('Cookie', adminCookie).send({ name: 'x' }))
        .status
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/racks/${rackId}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    // Admin can't see alice's modules either, even via rack_id filter.
    expect(
      (await request(app).get(`/api/modules?rack_id=${rackId}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
  });

  it('deletes a rack without touching shared modules or other racks', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const travel = await mapModule(db, rows[0].id, module.id, { rack: 'travel case' });

    const res = await request(app).delete(`/api/racks/${travel.id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);

    const { rows: mappings } = await db.query('SELECT * FROM rack_modules');
    expect(mappings).toHaveLength(1);
    const { rows: modules } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(modules).toHaveLength(1);
    // The module is still in the remaining rack.
    const detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.racks.map((r) => r.name)).toEqual(['main rack']);
  });

  it('deleting the last rack keeps its modules and your related records', async () => {
    const { app, db, manualsDir, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');
    const module = await insertModule(db, alice.id, { manual_hash: PDF_HASH });
    fs.writeFileSync(manualPath(manualsDir, PDF_HASH), PDF_BYTES);
    const { rows: comp } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'In') RETURNING id`,
      [module.id]
    );

    // Alice's question on the module and note on its component stay put, as
    // does the admin's question on the same module.
    const { rows: q } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status) VALUES ($1, 'Q', 'A', 'answered') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      q[0].id,
      module.id,
    ]);
    const { rows: n } = await db.query(
      `INSERT INTO notes (user_id, body) VALUES ($1, 'patch idea') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO note_components (note_id, component_id) VALUES ($1, $2)', [
      n[0].id,
      comp[0].id,
    ]);
    const { rows: adminQ } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'Theirs', 'answered') RETURNING id`,
      [admin.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      adminQ[0].id,
      module.id,
    ]);

    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const res = await request(app).delete(`/api/racks/${racks[0].id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);

    // The rack and its mappings go; everything the module knows about itself
    // stays on the server, ready for whoever imports it next.
    expect((await db.query('SELECT * FROM racks')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM rack_modules')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM modules')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM module_components')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM manuals')).rows).toHaveLength(1);
    expect(fs.existsSync(manualPath(manualsDir, PDF_HASH))).toBe(true);
    expect((await db.query('SELECT * FROM notes')).rows).toHaveLength(1);
    const { rows: questions } = await db.query('SELECT id, user_id FROM questions ORDER BY id');
    expect(questions).toEqual([
      { id: q[0].id, user_id: alice.id },
      { id: adminQ[0].id, user_id: admin.id },
    ]);
    expect((await db.query('SELECT * FROM question_modules')).rows).toHaveLength(2);

    // Alice no longer has it: the module is only reachable through a rack.
    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie)).status
    ).toBe(404);
  });

  it('moves a module between racks, merging quantities', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const module = await insertModule(db, alice.id, { quantity: 2 });
    const list = await request(app).get('/api/racks').set('Cookie', aliceCookie);
    const main = list.body[0];
    const travel = (
      await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'travel case' })
    ).body;

    const move = await request(app)
      .post(`/api/racks/${main.id}/modules/${module.id}/move`)
      .set('Cookie', aliceCookie)
      .send({ to_rack_id: travel.id });
    expect(move.status).toBe(200);

    let detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.racks).toEqual([{ id: travel.id, name: 'travel case', quantity: 2 }]);

    // Moving back onto a rack that already has the module merges quantities.
    await mapModule(db, alice.id, module.id, { rack: 'main rack', quantity: 1 });
    const merge = await request(app)
      .post(`/api/racks/${travel.id}/modules/${module.id}/move`)
      .set('Cookie', aliceCookie)
      .send({ to_rack_id: main.id });
    expect(merge.status).toBe(200);
    detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.racks).toEqual([{ id: main.id, name: 'main rack', quantity: 3 }]);
    expect(detail.body.quantity).toBe(3);
  });

  it('sets a rack module quantity, trimming layout placements that exceed it', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const module = await insertModule(db, alice.id, { quantity: 3, hp: 20 });
    const list = await request(app).get('/api/racks').set('Cookie', aliceCookie);
    const main = list.body[0];

    // Two of the three copies are placed in the layout.
    const layout = await request(app)
      .put(`/api/racks/${main.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({ rows: [{ unit: 3, hp: 84, modules: [{ module_id: module.id }, { module_id: module.id }] }] });
    expect(layout.status).toBe(200);

    // Not the owner, bad quantities, and unknown mappings are rejected.
    expect(
      (
        await request(app)
          .put(`/api/racks/${main.id}/modules/${module.id}`)
          .set('Cookie', adminCookie)
          .send({ quantity: 5 })
      ).status
    ).toBe(404);
    for (const quantity of [0, 1.5, 'many', 100]) {
      expect(
        (
          await request(app)
            .put(`/api/racks/${main.id}/modules/${module.id}`)
            .set('Cookie', aliceCookie)
            .send({ quantity })
        ).status
      ).toBe(400);
    }
    expect(
      (
        await request(app)
          .put(`/api/racks/${main.id}/modules/${module.id + 1}`)
          .set('Cookie', aliceCookie)
          .send({ quantity: 2 })
      ).status
    ).toBe(404);

    const res = await request(app)
      .put(`/api/racks/${main.id}/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ quantity: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, quantity: 1 });

    // The quantity shrank and the layout kept only one placement.
    const detail = await request(app).get(`/api/racks/${main.id}`).set('Cookie', aliceCookie);
    expect(detail.body.modules.map((m) => m.quantity)).toEqual([1]);
    expect(detail.body.rows[0].modules).toHaveLength(1);
  });

  it('rejects moves involving racks or modules that are not yours', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const module = await insertModule(db, alice.id);
    const aliceRacks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const other = (
      await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'other' })
    ).body;

    // Admin can't move modules out of alice's rack.
    expect(
      (
        await request(app)
          .post(`/api/racks/${aliceRacks[0].id}/modules/${module.id}/move`)
          .set('Cookie', adminCookie)
          .send({ to_rack_id: other.id })
      ).status
    ).toBe(404);
    // Alice can't target a rack she doesn't own.
    const adminRack = (
      await request(app).post('/api/racks').set('Cookie', adminCookie).send({ name: 'theirs' })
    ).body;
    expect(
      (
        await request(app)
          .post(`/api/racks/${aliceRacks[0].id}/modules/${module.id}/move`)
          .set('Cookie', aliceCookie)
          .send({ to_rack_id: adminRack.id })
      ).status
    ).toBe(404);
    // Same-rack moves and missing targets are rejected.
    expect(
      (
        await request(app)
          .post(`/api/racks/${aliceRacks[0].id}/modules/${module.id}/move`)
          .set('Cookie', aliceCookie)
          .send({ to_rack_id: aliceRacks[0].id })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/racks/${aliceRacks[0].id}/modules/${module.id}/move`)
          .set('Cookie', aliceCookie)
          .send({})
      ).status
    ).toBe(400);
  });

  // Reorganizing a case is a job of many modules at once.
  it('moves a selection of modules in one go, merging quantities', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const maths = await insertModule(db, alice.id, { hp: 20 });
    const pam = await insertModule(db, alice.id, { manufacturer: 'ALM', name: 'Pam', hp: 8 });
    const stayed = await insertModule(db, alice.id, {
      manufacturer: 'Mutable',
      name: 'Plaits',
      hp: 12,
    });
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const main = racks.find((r) => r.name === 'main rack');
    const travel = (
      await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'travel case' })
    ).body;
    // The target already holds one Pam, so that one merges rather than moves.
    await mapModule(db, alice.id, pam.id, { rack: 'travel case', quantity: 2 });

    const res = await request(app)
      .post(`/api/racks/${main.id}/modules/move`)
      .set('Cookie', aliceCookie)
      .send({ to_rack_id: travel.id, module_ids: [maths.id, pam.id] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, moved: 2, to_rack_id: travel.id });

    const from = await request(app).get(`/api/racks/${main.id}`).set('Cookie', aliceCookie);
    expect(from.body.modules.map((m) => m.name)).toEqual(['Plaits']);
    const to = await request(app).get(`/api/racks/${travel.id}`).set('Cookie', aliceCookie);
    expect(to.body.modules.map((m) => [m.name, m.quantity]).sort()).toEqual([
      ['Maths', 1],
      ['Pam', 3],
    ]);
    void stayed;
  });

  // rack_modules is the inventory a layout draws from, so a module the rack
  // no longer holds must not be left standing in one of its rows.
  it('takes a moved module out of the source rack’s physical rows', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const maths = await insertModule(db, alice.id, { hp: 20 });
    const pam = await insertModule(db, alice.id, { manufacturer: 'ALM', name: 'Pam', hp: 8 });
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const main = racks.find((r) => r.name === 'main rack');
    const travel = (
      await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'travel case' })
    ).body;
    await request(app)
      .put(`/api/racks/${main.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        rows: [{ unit: 3, hp: 84, modules: [{ module_id: maths.id }, { module_id: pam.id }] }],
      });

    await request(app)
      .post(`/api/racks/${main.id}/modules/move`)
      .set('Cookie', aliceCookie)
      .send({ to_rack_id: travel.id, module_ids: [maths.id] });

    const detail = await request(app).get(`/api/racks/${main.id}`).set('Cookie', aliceCookie);
    expect(detail.body.rows[0].modules.map((m) => m.name)).toEqual(['Pam']);
    // And the placement is gone rather than merely hidden, so moving the
    // module back does not make it reappear in its old slot.
    const { rows: placements } = await db.query(
      'SELECT module_id FROM rack_row_modules WHERE module_id = $1',
      [maths.id]
    );
    expect(placements).toEqual([]);
  });

  it('validates a bulk move and writes nothing when any module is not in the rack', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const maths = await insertModule(db, alice.id);
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const main = racks.find((r) => r.name === 'main rack');
    const travel = (
      await request(app).post('/api/racks').set('Cookie', aliceCookie).send({ name: 'travel case' })
    ).body;
    const bulk = (cookie, body) =>
      request(app).post(`/api/racks/${main.id}/modules/move`).set('Cookie', cookie).send(body);

    // An empty or oversized list, a missing target, and the same rack twice.
    expect((await bulk(aliceCookie, { to_rack_id: travel.id, module_ids: [] })).status).toBe(400);
    expect(
      (
        await bulk(aliceCookie, {
          to_rack_id: travel.id,
          module_ids: Array.from({ length: 201 }, (_, i) => i + 1),
        })
      ).status
    ).toBe(400);
    expect((await bulk(aliceCookie, { module_ids: [maths.id] })).status).toBe(400);
    expect((await bulk(aliceCookie, { to_rack_id: main.id, module_ids: [maths.id] })).status).toBe(
      400
    );
    expect(
      (await bulk(aliceCookie, { to_rack_id: travel.id, module_ids: ['nope'] })).status
    ).toBe(400);
    // Somebody else's rack is invisible either end.
    expect((await bulk(adminCookie, { to_rack_id: travel.id, module_ids: [maths.id] })).status).toBe(
      404
    );

    // One module in the rack and one that is not: the whole list is refused
    // and the module that WAS movable stays put.
    const elsewhere = await insertModule(db, alice.id, {
      manufacturer: 'ALM',
      name: 'Pam',
      rack: 'travel case',
    });
    const partial = await bulk(aliceCookie, {
      to_rack_id: travel.id,
      module_ids: [maths.id, elsewhere.id],
    });
    expect(partial.status).toBe(404);
    expect(partial.body.error).toMatch(/not in this rack/);
    const after = await request(app).get(`/api/racks/${main.id}`).set('Cookie', aliceCookie);
    expect(after.body.modules.map((m) => m.name)).toEqual(['Maths']);
  });

  it('scopes module list and delete to a rack via rack_id', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = rows[0];
    const maths = await insertModule(db, alice.id, { quantity: 1 });
    await mapModule(db, alice.id, maths.id, { rack: 'travel case', quantity: 2 });
    const pam = await insertModule(db, alice.id, { manufacturer: 'ALM', name: 'Pam' });
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    const travel = racks.find((r) => r.name === 'travel case');

    // All racks: deduped, quantities summed, placements listed.
    const all = (await request(app).get('/api/modules').set('Cookie', aliceCookie)).body;
    const mathsRow = all.find((m) => m.id === maths.id);
    expect(all).toHaveLength(2);
    expect(mathsRow.quantity).toBe(3);
    expect(mathsRow.racks.map((r) => r.name).sort()).toEqual(['main rack', 'travel case']);

    // One rack: only its modules and quantities.
    const scoped = (
      await request(app).get(`/api/modules?rack_id=${travel.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(maths.id);
    expect(scoped[0].quantity).toBe(2);

    // Deleting scoped to a rack leaves the other placement alone.
    await request(app)
      .delete(`/api/modules/${maths.id}?rack_id=${travel.id}`)
      .set('Cookie', aliceCookie);
    const after = (await request(app).get('/api/modules').set('Cookie', aliceCookie)).body;
    expect(after.find((m) => m.id === maths.id).racks.map((r) => r.name)).toEqual(['main rack']);
    expect(after.find((m) => m.id === pam.id)).toBeTruthy();
  });
});
