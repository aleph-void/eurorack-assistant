import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule, PDF_BYTES, PDF_HASH } from './helpers.js';
import { getQueuePause, pauseQueue } from '../src/services/config.js';

describe('modules API', () => {
  it('lists only the current user’s modules', async () => {
    const { app, db, aliceCookie } = await createTestApp();
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
    const { rows: components } = await db.query(
      `INSERT INTO module_components (module_id, type, name, description, voltage_min, voltage_max, polarity)
       VALUES ($1, 'input_jack', 'Signal In', 'Input', -5, 5, 'bipolar') RETURNING id`,
      [module.id]
    );
    await db.query(
      `INSERT INTO component_normalizations (module_id, target_component_id, source_label, kind, description)
       VALUES ($1, $2, 'internal oscillator', 'internal', 'Runs into the input by default.')`,
      [module.id, components[0].id]
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
    expect(res.body.normalizations).toHaveLength(1);
    expect(res.body.normalizations[0]).toMatchObject({
      target_component_id: components[0].id,
      source_component_id: null,
      source_label: 'internal oscillator',
      kind: 'internal',
      description: 'Runs into the input by default.',
    });
  });

  it('lets a racked user add and remove a jack with its panel marker', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id, { manufacturer: '2hp', name: 'ARP' });
    await db.query(
      `INSERT INTO module_panels (module_id, image_hash, image_ext, width, height)
       VALUES ($1, 'test-panel', 'svg', 100, 500)`,
      [module.id]
    );

    const created = await request(app)
      .post(`/api/modules/${module.id}/components`)
      .set('Cookie', aliceCookie)
      .send({ name: 'CLOCK OUT', type: 'output_jack' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'CLOCK OUT', type: 'output_jack' });
    expect(created.body.panel_placement_id).not.toBeNull();
    expect(
      (await db.query('SELECT component_id FROM module_panel_components WHERE id = $1', [created.body.panel_placement_id]))
        .rows
    ).toEqual([{ component_id: created.body.id }]);
    const withJack = await request(app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie);
    expect(withJack.body.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.id, name: 'CLOCK OUT', type: 'output_jack' }),
      ])
    );
    expect(withJack.body.panel.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component_id: created.body.id, name: 'CLOCK OUT', shape: 'jack' }),
      ])
    );

    const removed = await request(app)
      .delete(`/api/modules/${module.id}/components/${created.body.id}`)
      .set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
    expect((await db.query('SELECT * FROM module_components WHERE id = $1', [created.body.id])).rows).toEqual([]);
    const withoutJack = await request(app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie);
    expect(withoutJack.body.components.some((c) => c.id === created.body.id)).toBe(false);
    expect(withoutJack.body.panel.components.some((c) => c.component_id === created.body.id)).toBe(false);
  });

  it('lets a racked user rename a component and edit its description', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id, { manufacturer: 'Make Noise', name: 'Maths' });
    const { rows: components } = await db.query(
      `INSERT INTO module_components (module_id, type, name, description)
       VALUES ($1, 'input_jack', 'IN 1', 'Signal input') RETURNING id`,
      [module.id]
    );
    const componentId = components[0].id;
    const { rows: panels } = await db.query(
      `INSERT INTO module_panels (module_id, image_hash, image_ext, width, height)
       VALUES ($1, 'test-panel', 'svg', 100, 500) RETURNING id`,
      [module.id]
    );
    await db.query(
      `INSERT INTO module_panel_components (panel_id, component_id, name, shape, x, y, w, h)
       VALUES ($1, $2, 'IN 1', 'jack', 10, 10, 8, 8)`,
      [panels[0].id, componentId]
    );

    const renamed = await request(app)
      .put(`/api/modules/${module.id}/components/${componentId}`)
      .set('Cookie', aliceCookie)
      .send({ name: '  CH 1 SIGNAL  ', description: 'Channel 1 signal input' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'CH 1 SIGNAL',
      description: 'Channel 1 signal input',
      type: 'input_jack',
    });
    // The panel marker labels itself with a snapshot of the name; a rename
    // keeps it in step.
    expect(
      (await db.query('SELECT name FROM module_panel_components WHERE component_id = $1', [componentId])).rows
    ).toEqual([{ name: 'CH 1 SIGNAL' }]);

    // Clearing the description stores NULL; a blank name is rejected.
    const cleared = await request(app)
      .put(`/api/modules/${module.id}/components/${componentId}`)
      .set('Cookie', aliceCookie)
      .send({ description: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.description).toBe(null);

    const blank = await request(app)
      .put(`/api/modules/${module.id}/components/${componentId}`)
      .set('Cookie', aliceCookie)
      .send({ name: '   ' });
    expect(blank.status).toBe(400);
    expect(
      (await db.query('SELECT name FROM module_components WHERE id = $1', [componentId])).rows
    ).toEqual([{ name: 'CH 1 SIGNAL' }]);
  });

  it('adds a missing panel marker for an existing analyzed jack', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id, { manufacturer: '2hp', name: 'ARP' });
    const { rows: components } = await db.query(
      `INSERT INTO module_components (module_id, type, name, polarity)
       VALUES ($1, 'input_jack', 'FM IN', 'bipolar') RETURNING id`,
      [module.id]
    );
    await db.query(
      `INSERT INTO module_panels (module_id, image_hash, image_ext, width, height)
       VALUES ($1, 'test-panel', 'svg', 100, 500)`,
      [module.id]
    );

    const created = await request(app)
      .post(`/api/modules/${module.id}/panel/components`)
      .set('Cookie', aliceCookie)
      .send({ component_id: components[0].id });

    expect(created.status).toBe(201);
    expect(created.body.panel.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.placement_id,
          component_id: components[0].id,
          name: 'FM IN',
          shape: 'jack',
        }),
      ])
    );
  });

  it('manually adds normalled connections, deriving the kind from the source', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id);
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'input_jack', 'Filter In'),
         ($1, 'output_jack', 'Osc Out') RETURNING id, name`,
      [module.id]
    );
    const filterIn = jacks.find((j) => j.name === 'Filter In');
    const oscOut = jacks.find((j) => j.name === 'Osc Out');

    const fromJack = await request(app)
      .post(`/api/modules/${module.id}/normalizations`)
      .set('Cookie', aliceCookie)
      .send({
        target_component_id: filterIn.id,
        source_component_id: oscOut.id,
        description: 'Oscillator feeds the filter by default.',
      });
    expect(fromJack.status).toBe(201);
    expect(fromJack.body).toMatchObject({
      target_component_id: filterIn.id,
      source_component_id: oscOut.id,
      source_label: null,
      kind: 'output',
      description: 'Oscillator feeds the filter by default.',
    });

    const internal = await request(app)
      .post(`/api/modules/${module.id}/normalizations`)
      .set('Cookie', aliceCookie)
      .send({ target_component_id: filterIn.id, source_label: 'internal noise source' });
    expect(internal.status).toBe(201);
    expect(internal.body).toMatchObject({
      source_component_id: null,
      source_label: 'internal noise source',
      kind: 'internal',
      description: null,
    });

    const detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.normalizations).toHaveLength(2);
  });

  it('validates manual normalizations and rejects duplicates', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id);
    const other = await insertModule(db, users[0].id, { manufacturer: 'ALM', name: 'Pam' });
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'input_jack', 'In 1'),
         ($1, 'input_jack', 'In 2') RETURNING id, name`,
      [module.id]
    );
    const { rows: foreign } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'Out') RETURNING id`,
      [other.id]
    );
    const [in1, in2] = jacks;
    const post = (body, cookie = aliceCookie) =>
      request(app)
        .post(`/api/modules/${module.id}/normalizations`)
        .set('Cookie', cookie)
        .send(body);

    // Target and source must be components of THIS module.
    expect((await post({ target_component_id: foreign[0].id, source_component_id: in1.id })).status).toBe(400);
    expect((await post({ target_component_id: in2.id, source_component_id: foreign[0].id })).status).toBe(400);
    // A source (component or label) is required, and self-normalling is not a thing.
    expect((await post({ target_component_id: in2.id })).status).toBe(400);
    expect((await post({ target_component_id: in2.id, source_component_id: in2.id })).status).toBe(400);
    // The module must be in one of the requesting user's racks.
    expect((await post({ target_component_id: in2.id, source_component_id: in1.id }, adminCookie)).status).toBe(404);

    expect((await post({ target_component_id: in2.id, source_component_id: in1.id })).status).toBe(201);
    expect((await post({ target_component_id: in2.id, source_component_id: in1.id })).status).toBe(409);
    expect((await post({ target_component_id: in2.id, source_label: 'Ramp' })).status).toBe(201);
    expect((await post({ target_component_id: in2.id, source_label: 'ramp' })).status).toBe(409);
  });

  it('deletes normalizations only through a module the user has racked', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, users[0].id);
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'In') RETURNING id`,
      [module.id]
    );
    const { rows: norm } = await db.query(
      `INSERT INTO component_normalizations (module_id, target_component_id, source_label, kind)
       VALUES ($1, $2, 'internal LFO', 'internal') RETURNING id`,
      [module.id, jacks[0].id]
    );

    // Admin hasn't racked the module, so even an admin gets a 404.
    expect(
      (
        await request(app)
          .delete(`/api/modules/${module.id}/normalizations/${norm[0].id}`)
          .set('Cookie', adminCookie)
      ).status
    ).toBe(404);

    const res = await request(app)
      .delete(`/api/modules/${module.id}/normalizations/${norm[0].id}`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    const { rows: left } = await db.query('SELECT * FROM component_normalizations');
    expect(left).toHaveLength(0);

    expect(
      (
        await request(app)
          .delete(`/api/modules/${module.id}/normalizations/${norm[0].id}`)
          .set('Cookie', aliceCookie)
      ).status
    ).toBe(404);
  });

  it('hides unmapped modules; removing one keeps the shared record on the server', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');
    const module = await insertModule(db, alice.id);

    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);

    await mapModule(db, admin.id, module.id);
    expect(
      (await request(app).delete(`/api/modules/${module.id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);
    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie)).status
    ).toBe(404);

    // The shared module record survives while another user still has it…
    const { rows: still } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(still).toHaveLength(1);

    // …and also once its last rack mapping is gone: nobody can see it, but
    // importing the same manufacturer + name again picks it back up.
    expect(
      (await request(app).delete(`/api/modules/${module.id}`).set('Cookie', adminCookie)).status
    ).toBe(200);
    const { rows: kept } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(kept).toHaveLength(1);
    expect((await db.query('SELECT * FROM rack_modules')).rows).toHaveLength(0);
    expect(
      (await request(app).get(`/api/modules/${module.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
  });

  it('cleans up only the leaving user\'s own notes, questions and uploads, keeping the shared module and manual', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows: users } = await db.query('SELECT id, username FROM users');
    const alice = users.find((u) => u.username === 'alice');
    const admin = users.find((u) => u.username === 'admin');

    // A module alice racks, with a shared found manual and an upload of hers.
    const module = await insertModule(db, alice.id, { manual_hash: PDF_HASH });
    await db.models.Manual.create({
      module_id: module.id,
      user_id: alice.id,
      hash: 'a'.repeat(64),
      name: 'my upload',
      source: 'upload',
    });
    const aliceNote = (
      await request(app)
        .post('/api/notes')
        .set('Cookie', aliceCookie)
        .send({ title: 'mine', body: 'about maths', module_ids: [module.id] })
    ).body;
    const { rows: aliceQ } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'q', 'answered') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      aliceQ[0].id,
      module.id,
    ]);

    // The same module is in admin's rack, with their own note about it.
    await mapModule(db, admin.id, module.id);
    const adminNote = (
      await request(app)
        .post('/api/notes')
        .set('Cookie', adminCookie)
        .send({ title: 'theirs', body: 'also about maths', module_ids: [module.id] })
    ).body;

    // Alice removes the module from her rack.
    const del = await request(app).delete(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
    expect(del.body.removed).toMatchObject({ notes: 1, questions: 1, manuals: 1 });

    // The shared module and its found manual stay.
    expect((await db.query('SELECT 1 FROM modules WHERE id = $1', [module.id])).rows).toHaveLength(1);
    expect(
      (await db.query('SELECT 1 FROM manuals WHERE module_id = $1 AND user_id IS NULL', [module.id]))
        .rows
    ).toHaveLength(1);

    // Alice's own note, question and upload are gone.
    expect((await db.query('SELECT 1 FROM notes WHERE id = $1', [aliceNote.id])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM questions WHERE id = $1', [aliceQ[0].id])).rows).toHaveLength(0);
    expect(
      (await db.query('SELECT 1 FROM manuals WHERE module_id = $1 AND user_id = $2', [module.id, alice.id])).rows
    ).toHaveLength(0);

    // Admin's note about the same module is untouched.
    expect((await db.query('SELECT 1 FROM notes WHERE id = $1', [adminNote.id])).rows).toHaveLength(1);
  });

  it('keeps the private data when the module is still in another of your racks', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const alice = users[0];
    const module = await insertModule(db, alice.id);
    await mapModule(db, alice.id, module.id, { rack: 'travel case' });
    const note = (
      await request(app)
        .post('/api/notes')
        .set('Cookie', aliceCookie)
        .send({ title: 'keep', body: 'x', module_ids: [module.id] })
    ).body;

    const { rows: racks } = await db.query(
      "SELECT id FROM racks WHERE user_id = $1 AND name = 'travel case'",
      [alice.id]
    );
    // Remove from just the travel case; it is still in the main rack.
    const del = await request(app)
      .delete(`/api/modules/${module.id}?rack_id=${racks[0].id}`)
      .set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBeUndefined();
    expect((await db.query('SELECT 1 FROM notes WHERE id = $1', [note.id])).rows).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const { app } = await createTestApp();
    expect((await request(app).get('/api/modules')).status).toBe(401);
  });
});

// PATCH /api/modules/:id — correcting a module's naming and HP in place,
// without triggering any re-analysis.
describe('module edit API', () => {
  it('updates the naming and HP for a racked user', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, {
      manufacturer: 'Make Nose',
      name: 'Math',
      analysis_status: 'complete',
    });

    const res = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ manufacturer: 'Make Noise', name: 'Maths', hp: '20' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ manufacturer: 'Make Noise', name: 'Maths', hp: 20 });

    const saved = await db.models.Module.findByPk(module.id);
    expect(saved.manufacturer).toBe('Make Noise');
    expect(saved.name).toBe('Maths');
    expect(saved.hp).toBe(20);
    // A plain correction, not a re-analysis: no job was queued and the
    // analysis state is untouched.
    expect(saved.analysis_status).toBe('complete');
    expect((await db.query('SELECT id FROM jobs')).rows).toEqual([]);
  });

  it('updates HP alone and clears it with an empty value', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, { hp: 8 });

    const res = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ hp: 10 });
    expect(res.status).toBe(200);
    expect((await db.models.Module.findByPk(module.id)).hp).toBe(10);

    const cleared = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ hp: '' });
    expect(cleared.status).toBe(200);
    expect((await db.models.Module.findByPk(module.id)).hp).toBeNull();
  });

  it('rejects empty fields, bad HP and empty bodies', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);

    for (const body of [{ name: '  ' }, { manufacturer: '' }, { hp: 'wide' }, { hp: -4 }, {}]) {
      const res = await request(app)
        .patch(`/api/modules/${module.id}`)
        .set('Cookie', aliceCookie)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const saved = await db.models.Module.findByPk(module.id);
    expect(saved.name).toBe('Maths');
    expect(saved.manufacturer).toBe('Make Noise');
  });

  it('refuses a rename that collides with another module, case-insensitively', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await insertModule(db, rows[0].id, { manufacturer: 'ALM', name: 'Pamela’s PRO Workout' });
    const module = await insertModule(db, rows[0].id, { manufacturer: 'ALM', name: 'Pam' });

    const res = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'pamela’s pro workout' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
    expect((await db.models.Module.findByPk(module.id)).name).toBe('Pam');
  });

  it('keeps its own naming when only the case changes', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, { manufacturer: 'make noise', name: 'maths' });

    const res = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ manufacturer: 'Make Noise', name: 'Maths' });
    expect(res.status).toBe(200);
    expect((await db.models.Module.findByPk(module.id)).manufacturer).toBe('Make Noise');
  });

  it('is only offered on modules in the requester’s racks', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const module = await insertModule(db, rows[0].id);

    const res = await request(app)
      .patch(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect((await db.models.Module.findByPk(module.id)).name).toBe('Maths');
  });
});

// POST /api/modules/:id/reanalyze — one module's component re-analysis with
// freshly fetched retailer product pages.
describe('module re-analysis API', () => {
  it('is only offered on modules in the requester’s racks', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const module = await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    const res = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(404);
    // The owner can, proving the 404 was about the rack and not the route.
    const ok = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', adminCookie);
    expect(ok.status).toBe(202);
  });

  it('refuses a module with no manual to re-analyze from', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const res = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no manual/i);
  });

  it('refuses while any retailer product page already exists', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: 'd'.repeat(64),
      original_name: 'Make_Noise_Maths_Detroit_Modular_Product_Page.pdf',
      source: 'found',
    });
    const res = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exist/i);
    expect(res.body.documents).toEqual(['Make_Noise_Maths_Detroit_Modular_Product_Page.pdf']);
    expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });

  it('queues one reanalyze_components job and dedupes a second request', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id, username FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });

    const res = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(202);
    const { rows: jobs } = await db.query('SELECT * FROM jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'reanalyze_components',
      module_id: module.id,
      user_id: rows[0].id,
      status: 'pending',
    });
    expect(res.body.job_id).toBe(jobs[0].id);
    const { rows: updated } = await db.query('SELECT analysis_status FROM modules WHERE id = $1', [
      module.id,
    ]);
    expect(updated[0].analysis_status).toBe('pending');

    // The job is still pending, so asking again queues nothing new.
    const again = await request(app)
      .post(`/api/modules/${module.id}/reanalyze`)
      .set('Cookie', aliceCookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already queued/i);
    expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(1);
  });
});

// POST /api/modules/:id/analyze — rebuild the manual analysis from the
// documents already saved, vendor pages included, fetching nothing.
describe('module analysis rebuild API', () => {
  it('is only offered on modules in the requester’s racks', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const module = await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    const res = await request(app)
      .post(`/api/modules/${module.id}/analyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(404);
    const ok = await request(app)
      .post(`/api/modules/${module.id}/analyze`)
      .set('Cookie', adminCookie);
    expect(ok.status).toBe(202);
  });

  it('refuses a module with no manual, counting a lone vendor page as no manual', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: 'd'.repeat(64),
      original_name: 'Make_Noise_Maths_Detroit_Modular_Product_Page.pdf',
      source: 'found',
    });
    const res = await request(app)
      .post(`/api/modules/${module.id}/analyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no manual/i);
    expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });

  it('queues one rebuild analyze_manual job and dedupes a second request', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id, { manual_hash: PDF_HASH });
    // Vendor pages on disk are exactly the case /reanalyze refuses; this
    // route accepts them, because they are what gets re-submitted.
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: 'd'.repeat(64),
      original_name: 'Make_Noise_Maths_Perfect_Circuit_Product_Page.pdf',
      source: 'found',
    });

    const res = await request(app)
      .post(`/api/modules/${module.id}/analyze`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(202);
    const { rows: jobs } = await db.query('SELECT * FROM jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'analyze_manual',
      module_id: module.id,
      user_id: rows[0].id,
      status: 'pending',
    });
    expect(JSON.parse(jobs[0].payload)).toEqual({ rebuild: true });
    expect(res.body.job_id).toBe(jobs[0].id);
    const { rows: updated } = await db.query('SELECT analysis_status FROM modules WHERE id = $1', [
      module.id,
    ]);
    expect(updated[0].analysis_status).toBe('pending');

    const again = await request(app)
      .post(`/api/modules/${module.id}/analyze`)
      .set('Cookie', aliceCookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already queued/i);
    expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(1);
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

  it('re-uploading the same content references the existing record, renamed as asked', async () => {
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
    // The typed name is honored on the re-upload rather than silently kept;
    // the original file name still names the bytes that were first stored.
    expect(again.body.name).toBe('notes again');
    expect(again.body.original_name).toBe('notes.pdf');

    const { rows } = await db.query(
      'SELECT * FROM manuals WHERE module_id = $1 AND user_id IS NOT NULL',
      [module.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('notes again');
  });

  it('marks documents in scope for analysis, at upload or afterwards', async () => {
    const { app, db, adminCookie, aliceCookie, module } = await withModule();
    // At upload: the flag rides along and comes back in the response.
    const uploaded = await request(app)
      .post(`/api/modules/${module.id}/manuals`)
      .set('Cookie', aliceCookie)
      .send({
        name: 'panel notes',
        filename: 'panel.pdf',
        data_base64: otherBase64,
        analysis_scope: true,
      });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.analysis_scope).toBe(true);

    // Afterwards: the toggle flips it either way.
    const off = await request(app)
      .put(`/api/modules/${module.id}/manuals/${uploaded.body.id}/scope`)
      .set('Cookie', aliceCookie)
      .send({ analysis_scope: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ id: uploaded.body.id, analysis_scope: false });

    // The shared manual record is markable by any user who can see it…
    const { rows: shared } = await db.query(
      'SELECT id FROM manuals WHERE module_id = $1 AND user_id IS NULL',
      [module.id]
    );
    const sharedOn = await request(app)
      .put(`/api/modules/${module.id}/manuals/${shared[0].id}/scope`)
      .set('Cookie', aliceCookie)
      .send({ analysis_scope: true });
    expect(sharedOn.status).toBe(200);

    // …but another user's private upload is not yours to mark, even as an
    // admin, and non-boolean bodies are refused.
    const foreign = await request(app)
      .put(`/api/modules/${module.id}/manuals/${uploaded.body.id}/scope`)
      .set('Cookie', adminCookie)
      .send({ analysis_scope: true });
    expect(foreign.status).toBe(404);
    const junk = await request(app)
      .put(`/api/modules/${module.id}/manuals/${uploaded.body.id}/scope`)
      .set('Cookie', aliceCookie)
      .send({ analysis_scope: 'yes' });
    expect(junk.status).toBe(400);

    // The module page reports the flag with each document.
    const page = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    const doc = page.body.manuals.find((m) => m.id === uploaded.body.id);
    expect(doc.analysis_scope).toBe(false);
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
    // Per-job-type models are each user's own (/api/llm), not admin config.
    expect(res.body.llm_model_find_manual).toBeUndefined();
  });

  it('refuses the retired per-job-type model keys', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ llm_model_find_manual: 'claude-haiku-4-5' });
    expect(res.status).toBe(400);
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
    await insertModule(db, alice.id, { manufacturer: '2hp', name: 'Pluck' });
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

  // Asking about the patch in front of you: the patch is attached to the
  // question and the modules it uses come into scope with it.
  it('asks about a patch, offers it in review, and attaches it', async () => {
    const { app, db, aliceCookie, alice, moduleId, question } = await withScopedQuestion();
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'output_jack', 'EOR'), ($1, 'input_jack', 'Signal In') RETURNING id, name`,
      [moduleId]
    );
    const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
    const created = await request(app)
      .post('/api/patches')
      .set('Cookie', aliceCookie)
      .send({ rack_id: racks[0].id, name: 'Krell' });
    expect(created.status).toBe(201);
    const detail = await request(app)
      .get(`/api/patches/${created.body.id}`)
      .set('Cookie', aliceCookie);
    const pm = detail.body.modules.find((m) => m.module_id === moduleId);
    const cable = await request(app)
      .post(`/api/patches/${created.body.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: pm.id,
        from_component_id: jacks.find((j) => j.name === 'EOR').id,
        to_patch_module_id: pm.id,
        to_component_id: jacks.find((j) => j.name === 'Signal In').id,
      });
    expect(cable.status).toBe(201);

    // A new question can name the patch, which attaches it before scoping.
    const asked = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Why is there no sound?', patch_id: created.body.id });
    expect(asked.status).toBe(201);
    const { rows: attachedAtAsk } = await db.query(
      'SELECT * FROM question_patches WHERE question_id = $1',
      [asked.body.id]
    );
    expect(attachedAtAsk.map((l) => l.patch_id)).toEqual([created.body.id]);

    // The review step offers it, with the modules the patch actually uses.
    const options = await request(app)
      .get(`/api/questions/${question.id}/options`)
      .set('Cookie', aliceCookie);
    expect(options.status).toBe(200);
    expect(options.body.patches).toHaveLength(1);
    expect(options.body.patches[0]).toMatchObject({
      id: created.body.id,
      name: 'Krell',
      attached: false,
      module_ids: [moduleId],
    });

    // A patch on its own satisfies the "attach something" rule.
    const answered = await request(app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', aliceCookie)
      .send({ module_ids: [moduleId], patch_ids: [created.body.id] });
    expect(answered.status).toBe(200);
    const { rows: links } = await db.query(
      'SELECT * FROM question_patches WHERE question_id = $1',
      [question.id]
    );
    expect(links.map((l) => l.patch_id)).toEqual([created.body.id]);
    const shown = await request(app)
      .get(`/api/questions/${question.id}`)
      .set('Cookie', aliceCookie);
    expect(shown.body.patches).toEqual([
      { id: created.body.id, name: 'Krell', rack_name: 'main rack' },
    ]);
  });

  it("refuses another user's patch", async () => {
    const { app, db, aliceCookie, moduleId, question } = await withScopedQuestion();
    const { rows: others } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const { rows: patch } = await db.query(
      `INSERT INTO patches (user_id, rack_name, name) VALUES ($1, 'other rack', 'Someone else''s patch')
       RETURNING id`,
      [others[0].id]
    );
    const asked = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'Whose patch?', patch_id: patch[0].id });
    expect(asked.status).toBe(400);
    const reviewed = await request(app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', aliceCookie)
      .send({ module_ids: [moduleId], patch_ids: [patch[0].id] });
    expect(reviewed.status).toBe(400);
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

  it("deletes own questions with all their links, never another user's", async () => {
    const { app, db, aliceCookie, adminCookie, alice } = await withModules();
    // An answered question linked to the module, cited as a source by a
    // second question.
    const { rows: modules } = await db.query('SELECT id FROM modules');
    const { rows: q1 } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status) VALUES ($1, 'First', 'A1', 'answered') RETURNING id`,
      [alice.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      q1[0].id,
      modules[0].id,
    ]);
    const { rows: q2 } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'Second', 'pending') RETURNING id`,
      [alice.id]
    );
    await db.query(
      'INSERT INTO question_answers (question_id, source_question_id) VALUES ($1, $2)',
      [q2[0].id, q1[0].id]
    );

    // Another user cannot delete it.
    expect(
      (await request(app).delete(`/api/questions/${q1[0].id}`).set('Cookie', adminCookie)).status
    ).toBe(404);

    const res = await request(app).delete(`/api/questions/${q1[0].id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    const { rows: remaining } = await db.query('SELECT id FROM questions');
    expect(remaining.map((r) => r.id)).not.toContain(q1[0].id);
    // The citing question survives; only the citation link is gone.
    expect(remaining.map((r) => r.id)).toContain(q2[0].id);
    expect((await db.query('SELECT * FROM question_answers')).rows).toHaveLength(0);
    expect(
      (await db.query('SELECT * FROM question_modules WHERE question_id = $1', [q1[0].id])).rows
    ).toHaveLength(0);
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

  it('marks a job whose worker died as stalled and lets it be retried', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status, heartbeat_at)
       VALUES ('analyze_manual', $1, $2, 'running', $3) RETURNING *`,
      [rows[0].id, module.id, new Date(Date.now() - 60 * 60 * 1000)]
    );

    const list = await request(app).get('/api/jobs').set('Cookie', aliceCookie);
    expect(list.body[0].stalled).toBe(true);

    const retry = await request(app)
      .post(`/api/jobs/${jobs[0].id}/retry`)
      .set('Cookie', aliceCookie);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('pending');
  });

  it('refuses to retry a job that is still running', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status, heartbeat_at)
       VALUES ('analyze_manual', $1, $2, 'running', now()) RETURNING *`,
      [rows[0].id, module.id]
    );

    const list = await request(app).get('/api/jobs').set('Cookie', aliceCookie);
    expect(list.body[0].stalled).toBe(false);
    const retry = await request(app)
      .post(`/api/jobs/${jobs[0].id}/retry`)
      .set('Cookie', aliceCookie);
    expect(retry.status).toBe(400);
  });

  it("hides other users' jobs — even for a shared module — except from admins", async () => {
    const { app, db, adminCookie } = await createTestApp();
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

  it('stops a running job and hands its module back to pending', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    await db.query("UPDATE modules SET analysis_status = 'analyzing' WHERE id = $1", [module.id]);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status, heartbeat_at)
       VALUES ('analyze_manual', $1, $2, 'running', now()) RETURNING *`,
      [rows[0].id, module.id]
    );

    const stop = await request(app).post(`/api/jobs/${jobs[0].id}/stop`).set('Cookie', aliceCookie);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('cancelled');
    // The module was mid-analysis; with the job gone it goes back on the shelf
    // rather than claiming something is still analyzing it.
    const { rows: after } = await db.query('SELECT analysis_status FROM modules WHERE id = $1', [
      module.id,
    ]);
    expect(after[0].analysis_status).toBe('pending');
  });

  it('refuses to stop a job that has already finished', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status)
       VALUES ('find_manual', $1, $2, 'complete') RETURNING *`,
      [rows[0].id, module.id]
    );
    const stop = await request(app).post(`/api/jobs/${jobs[0].id}/stop`).set('Cookie', aliceCookie);
    expect(stop.status).toBe(400);
  });

  it('deletes a job, stopping it first when it is still live', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    await db.query("UPDATE modules SET manual_status = 'searching' WHERE id = $1", [module.id]);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status)
       VALUES ('find_manual', $1, $2, 'pending') RETURNING *`,
      [rows[0].id, module.id]
    );

    const del = await request(app).delete(`/api/jobs/${jobs[0].id}`).set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
    expect((await db.query('SELECT id FROM jobs')).rows).toHaveLength(0);
    const { rows: after } = await db.query('SELECT manual_status FROM modules WHERE id = $1', [
      module.id,
    ]);
    expect(after[0].manual_status).toBe('pending');
  });

  it('stops and deletes only the caller\'s own jobs in bulk', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: alice } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const { rows: admin } = await db.query('SELECT id FROM users WHERE is_admin = true');
    const module = await insertModule(db, alice[0].id);
    await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status) VALUES
         ('find_manual', $1, $3, 'pending'),
         ('analyze_manual', $1, $3, 'complete'),
         ('find_manual', $2, $3, 'pending')`,
      [alice[0].id, admin[0].id, module.id]
    );

    const stopped = await request(app).post('/api/jobs/stop-all').set('Cookie', aliceCookie);
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped).toBe(1); // only alice's pending one
    const { rows: statuses } = await db.query('SELECT user_id, status FROM jobs ORDER BY id');
    expect(statuses.map((r) => r.status)).toEqual(['cancelled', 'complete', 'pending']);

    const deleted = await request(app).delete('/api/jobs').set('Cookie', aliceCookie);
    expect(deleted.body.deleted).toBe(2);
    const { rows: left } = await db.query('SELECT user_id FROM jobs');
    expect(left.map((r) => Number(r.user_id))).toEqual([admin[0].id]);
  });

  it('lets no one, admin included, stop or delete a job they do not own', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const module = await insertModule(db, rows[0].id);
    const { rows: jobs } = await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status)
       VALUES ('find_manual', $1, $2, 'pending') RETURNING *`,
      [rows[0].id, module.id]
    );

    // The admin can see it and could retry it, but it is not theirs to bin.
    const list = await request(app).get('/api/jobs').set('Cookie', adminCookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].own).toBe(false);
    expect(
      (await request(app).post(`/api/jobs/${jobs[0].id}/stop`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/jobs/${jobs[0].id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect((await db.query('SELECT id FROM jobs')).rows).toHaveLength(1);

    // Its owner sees it as theirs and can.
    const own = await request(app).get('/api/jobs').set('Cookie', aliceCookie);
    expect(own.body[0].own).toBe(true);
    expect(
      (await request(app).delete(`/api/jobs/${jobs[0].id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);
  });

  it('clears out the jobs the caller stopped, and only those', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: alice } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const { rows: admin } = await db.query('SELECT id FROM users WHERE is_admin = true');
    const module = await insertModule(db, alice[0].id);
    await db.query(
      `INSERT INTO jobs (type, user_id, module_id, status) VALUES
         ('find_manual', $1, $3, 'cancelled'),
         ('analyze_manual', $1, $3, 'cancelled'),
         ('find_manual', $1, $3, 'failed'),
         ('find_manual', $1, $3, 'pending'),
         ('find_manual', $2, $3, 'cancelled')`,
      [alice[0].id, admin[0].id, module.id]
    );

    const removed = await request(app).delete('/api/jobs/cancelled').set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(2);
    // Alice's unfinished and failed jobs stay, and so does the admin's own
    // cancelled one — cancelled or not, it is not hers to bin.
    const { rows: left } = await db.query('SELECT user_id, status FROM jobs ORDER BY id');
    expect(left.map((r) => r.status)).toEqual(['failed', 'pending', 'cancelled']);
    expect(Number(left[2].user_id)).toBe(admin[0].id);
  });

  it('reports a queue paused because the provider is out of tokens', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const until = new Date(Date.now() + 60 * 60 * 1000);

    const running = await request(app).get('/api/jobs/queue').set('Cookie', aliceCookie);
    expect(running.body).toEqual({ paused: false, until: null, reason: '' });

    await pauseQueue(db, { until, reason: 'usage limit reached' });
    const paused = await request(app).get('/api/jobs/queue').set('Cookie', aliceCookie);
    expect(paused.body).toEqual({
      paused: true,
      until: until.toISOString(),
      reason: 'usage limit reached',
    });
  });

  it('reports a pause whose time has passed as a running queue', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    await pauseQueue(db, { until: Date.now() - 1000, reason: 'usage limit reached' });
    const res = await request(app).get('/api/jobs/queue').set('Cookie', aliceCookie);
    expect(res.body.paused).toBe(false);
  });

  it('lets any user start the paused queue again, and tells everyone', async () => {
    const published = [];
    const bus = { publish: () => {}, publishAll: (e) => published.push(e) };
    const { app, db, aliceCookie } = await createTestApp({ bus });
    await pauseQueue(db, { until: Date.now() + 60 * 60 * 1000, reason: 'usage limit reached' });

    // Alice is not an admin: the pause blocks her work, so it is hers to lift.
    const res = await request(app).post('/api/jobs/queue/resume').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect((await getQueuePause(db)).paused).toBe(false);
    expect(published).toEqual([
      { kind: 'queue', event: 'resumed', paused: false, until: null, reason: '' },
    ]);
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
