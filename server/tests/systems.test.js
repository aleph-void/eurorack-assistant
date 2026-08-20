import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule } from './helpers.js';

// A system is a collection of racks patched together as one instrument.
describe('systems API', () => {
  // Alice with two racks and one module in each, plus a system holding them.
  async function studio(app, cookie, db, aliceId) {
    const left = await insertModule(db, aliceId, {
      manufacturer: 'Make Noise',
      name: 'Maths',
      rack: 'left case',
      hp: 20,
    });
    const right = await insertModule(db, aliceId, {
      manufacturer: 'Mutable',
      name: 'Plaits',
      rack: 'right case',
      hp: 12,
    });
    const racks = (await request(app).get('/api/racks').set('Cookie', cookie)).body;
    const system = (
      await request(app).post('/api/systems').set('Cookie', cookie).send({ name: 'studio' })
    ).body;
    for (const rack of racks) {
      await request(app)
        .put(`/api/racks/${rack.id}/system`)
        .set('Cookie', cookie)
        .send({ system_id: system.id });
    }
    return {
      system,
      left,
      right,
      leftRack: racks.find((r) => r.name === 'left case'),
      rightRack: racks.find((r) => r.name === 'right case'),
    };
  }

  async function aliceId(db) {
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    return rows[0].id;
  }

  it('creates, lists, renames and deletes systems, keeping the racks', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system } = await studio(app, aliceCookie, db, alice);

    const list = await request(app).get('/api/systems').set('Cookie', aliceCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'studio', rack_count: 2, module_count: 2 });

    const renamed = await request(app)
      .put(`/api/systems/${system.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'the desk', description: 'everything' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'the desk', description: 'everything' });

    // Deleting the system leaves both racks — and their modules — intact.
    expect(
      (await request(app).delete(`/api/systems/${system.id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);
    const racks = await request(app).get('/api/racks').set('Cookie', aliceCookie);
    expect(racks.body.map((r) => [r.name, r.system_id])).toEqual([
      ['left case', null],
      ['right case', null],
    ]);
  });

  it('rejects duplicate and empty names, per user', async () => {
    const { app, aliceCookie, adminCookie } = await createTestApp();
    expect(
      (await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: '  ' }))
        .status
    ).toBe(400);
    const first = await request(app)
      .post('/api/systems')
      .set('Cookie', aliceCookie)
      .send({ name: 'studio' });
    expect(first.status).toBe(201);
    // Case-insensitive clash for the same user…
    expect(
      (await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'STUDIO' }))
        .status
    ).toBe(409);
    // …but another user may use the same name.
    expect(
      (await request(app).post('/api/systems').set('Cookie', adminCookie).send({ name: 'studio' }))
        .status
    ).toBe(201);

    const second = await request(app)
      .post('/api/systems')
      .set('Cookie', aliceCookie)
      .send({ name: 'live rig' });
    expect(
      (
        await request(app)
          .put(`/api/systems/${second.body.id}`)
          .set('Cookie', aliceCookie)
          .send({ name: 'studio' })
      ).status
    ).toBe(409);
    // Renaming to a different casing of its own name is fine.
    expect(
      (
        await request(app)
          .put(`/api/systems/${second.body.id}`)
          .set('Cookie', aliceCookie)
          .send({ name: 'LIVE RIG' })
      ).status
    ).toBe(200);
  });

  it('never shows or touches another user’s system', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system } = await studio(app, aliceCookie, db, alice);

    expect((await request(app).get('/api/systems').set('Cookie', adminCookie)).body).toEqual([]);
    expect(
      (await request(app).get(`/api/systems/${system.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .put(`/api/systems/${system.id}`)
          .set('Cookie', adminCookie)
          .send({ name: 'mine now' })
      ).status
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/systems/${system.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);
    // And alice's rack cannot be pulled into a system by anyone else.
    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    expect(
      (
        await request(app)
          .put(`/api/racks/${racks[0].id}/system`)
          .set('Cookie', adminCookie)
          .send({ system_id: system.id })
      ).status
    ).toBe(404);
  });

  it('shows a system with each rack’s modules and rows, plus the unassigned racks', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system, leftRack, left } = await studio(app, aliceCookie, db, alice);
    // A third rack, left out of the system.
    await insertModule(db, alice, { manufacturer: 'ALM', name: 'Pam', rack: 'skiff', hp: 8 });
    // Give the left case a physical row so the floor plan has something to draw.
    await request(app)
      .put(`/api/racks/${leftRack.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({ rows: [{ unit: 3, hp: 84, modules: [{ module_id: left.id }] }] });

    const res = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.racks.map((r) => r.name)).toEqual(['left case', 'right case']);
    expect(res.body.unassigned_racks.map((r) => r.name)).toEqual(['skiff']);
    const drawn = res.body.racks.find((r) => r.name === 'left case');
    expect(drawn.rows).toHaveLength(1);
    expect(drawn.rows[0].modules.map((m) => m.name)).toEqual(['Maths']);
    expect(drawn.modules.map((m) => m.name)).toEqual(['Maths']);
  });

  it('arranges racks on the floor plan and validates the coordinates', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system, leftRack, rightRack } = await studio(app, aliceCookie, db, alice);

    const saved = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        racks: [
          { rack_id: rightRack.id, x: 90, y: 0 },
          { rack_id: leftRack.id, x: 0, y: 6 },
        ],
      });
    expect(saved.status).toBe(200);
    // The order sent is the order stored, and it comes back in that order.
    expect(saved.body.racks.map((r) => [r.name, r.x, r.y, r.position])).toEqual([
      ['right case', 90, 0, 0],
      ['left case', 0, 6, 1],
    ]);
    const detail = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect(detail.body.racks.map((r) => r.name)).toEqual(['right case', 'left case']);

    // Out-of-range coordinates, unknown racks and repeats are all refused.
    for (const racks of [
      [{ rack_id: leftRack.id, x: -1, y: 0 }],
      [{ rack_id: leftRack.id, x: 0, y: 99999 }],
      [{ rack_id: 9999, x: 0, y: 0 }],
      [
        { rack_id: leftRack.id, x: 0, y: 0 },
        { rack_id: leftRack.id, x: 5, y: 5 },
      ],
    ]) {
      const bad = await request(app)
        .put(`/api/systems/${system.id}/layout`)
        .set('Cookie', aliceCookie)
        .send({ racks });
      expect(bad.status).toBe(400);
    }
    // Nothing moved.
    const after = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect(after.body.racks.map((r) => [r.name, r.system_x])).toEqual([
      ['right case', 90],
      ['left case', 0],
    ]);
  });

  it('keeps two racks from standing in the same place', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system, leftRack, rightRack } = await studio(app, aliceCookie, db, alice);

    // Neither rack has rows yet, so each takes the floor of a plain 84 HP,
    // 3U case — and joining the system stood them side by side rather than
    // both at the origin.
    const joined = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect(joined.body.racks.map((r) => [r.name, r.system_x, r.system_y])).toEqual([
      ['left case', 0, 0],
      ['right case', 84, 0],
    ]);
    expect(joined.body.racks.map((r) => [r.width_hp, r.height_u])).toEqual([
      [84, 3],
      [84, 3],
    ]);

    // Dropping one onto the other is refused, and says which two clash.
    const clash = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        racks: [
          { rack_id: leftRack.id, x: 0, y: 0 },
          { rack_id: rightRack.id, x: 40, y: 1 },
        ],
      });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/left case.*right case.*overlap/);

    // A rack the body leaves out still holds its floor.
    const bury = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({ racks: [{ rack_id: leftRack.id, x: 84, y: 0 }] });
    expect(bury.status).toBe(409);

    // Standing flush — one rack's right edge against the other's left — is
    // how cases really sit, so it is allowed.
    const flush = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        racks: [
          { rack_id: leftRack.id, x: 0, y: 3 },
          { rack_id: rightRack.id, x: 0, y: 0 },
        ],
      });
    expect(flush.status).toBe(200);
  });

  it('lets racks that already overlap be dragged apart', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system, leftRack, rightRack } = await studio(app, aliceCookie, db, alice);
    // A system arranged before racks were kept apart: everything piled up at
    // the origin. Refusing every save would leave it stuck that way, so a
    // rack that stays where it is may keep overlapping — only one that
    // actually moves has to come to rest somewhere free.
    await db.query('UPDATE racks SET system_x = 0, system_y = 0 WHERE system_id = $1', [system.id]);

    const apart = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        racks: [
          { rack_id: leftRack.id, x: 0, y: 0 },
          { rack_id: rightRack.id, x: 200, y: 0 },
        ],
      });
    expect(apart.status).toBe(200);
    expect(apart.body.racks.map((r) => [r.name, r.x])).toEqual([
      ['left case', 0],
      ['right case', 200],
    ]);
  });

  it('sizes the floor plan the system is arranged on', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system } = await studio(app, aliceCookie, db, alice);
    const opened = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect([opened.body.floor_width, opened.body.floor_height]).toEqual([140, 9]);

    // A studio that stands in one long row needs a plan far wider than that.
    const wider = await request(app)
      .put(`/api/systems/${system.id}`)
      .set('Cookie', aliceCookie)
      .send({ floor_width: 900, floor_height: 15 });
    expect(wider.status).toBe(200);
    expect([wider.body.floor_width, wider.body.floor_height]).toEqual([900, 15]);
    const reopened = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect([reopened.body.floor_width, reopened.body.floor_height]).toEqual([900, 15]);

    for (const body of [{ floor_width: 4 }, { floor_height: 1 }, { floor_width: 99999 }]) {
      const bad = await request(app)
        .put(`/api/systems/${system.id}`)
        .set('Cookie', aliceCookie)
        .send(body);
      expect(bad.status).toBe(400);
    }
    const unchanged = await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie);
    expect([unchanged.body.floor_width, unchanged.body.floor_height]).toEqual([900, 15]);
  });

  it('moves a rack between systems and out of one again', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { system, leftRack } = await studio(app, aliceCookie, db, alice);
    const other = (
      await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'live rig' })
    ).body;

    const moved = await request(app)
      .put(`/api/racks/${leftRack.id}/system`)
      .set('Cookie', aliceCookie)
      .send({ system_id: other.id });
    expect(moved.status).toBe(200);
    expect(moved.body.system_id).toBe(other.id);
    expect(
      (await request(app).get(`/api/systems/${system.id}`).set('Cookie', aliceCookie)).body.racks
    ).toHaveLength(1);

    const freed = await request(app)
      .put(`/api/racks/${leftRack.id}/system`)
      .set('Cookie', aliceCookie)
      .send({ system_id: null });
    expect(freed.status).toBe(200);
    expect(freed.body.system_id).toBe(null);
    // Taking a rack out resets where it stood, so it does not reappear at
    // some old coordinate when it joins another system.
    expect(freed.body.system_x).toBe(0);
    expect(freed.body.system_position).toBe(0);

    // A system that does not exist is a 404, and the rack does not move.
    expect(
      (
        await request(app)
          .put(`/api/racks/${leftRack.id}/system`)
          .set('Cookie', aliceCookie)
          .send({ system_id: 9999 })
      ).status
    ).toBe(404);
  });

  it('does not tell a share recipient which system the rack is in', async () => {
    const { app, db, aliceCookie, adminCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { leftRack } = await studio(app, aliceCookie, db, alice);
    const { rows: admins } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    await request(app)
      .put(`/api/shares/rack/${leftRack.id}`)
      .set('Cookie', aliceCookie)
      .send({ user_ids: [admins[0].id] });

    // The owner sees where the rack stands; the recipient sees the rack.
    const mine = await request(app).get(`/api/racks/${leftRack.id}`).set('Cookie', aliceCookie);
    expect(mine.body.system_id).toBeGreaterThan(0);
    const theirs = await request(app).get(`/api/racks/${leftRack.id}`).set('Cookie', adminCookie);
    expect(theirs.status).toBe(200);
    expect(theirs.body.shared).toBe(true);
    expect(theirs.body.modules.map((m) => m.name)).toEqual(['Maths']);
    expect('system_id' in theirs.body).toBe(false);
    expect('system_x' in theirs.body).toBe(false);
  });

  it('moves a module from one rack of a system to another, merging quantities', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const alice = await aliceId(db);
    const { leftRack, rightRack, left } = await studio(app, aliceCookie, db, alice);
    // The right case already holds one Maths of its own, so the move merges.
    await mapModule(db, alice, left.id, { rack: 'right case', quantity: 2 });

    const moved = await request(app)
      .post(`/api/racks/${leftRack.id}/modules/${left.id}/move`)
      .set('Cookie', aliceCookie)
      .send({ to_rack_id: rightRack.id });
    expect(moved.status).toBe(200);

    const from = await request(app).get(`/api/racks/${leftRack.id}`).set('Cookie', aliceCookie);
    expect(from.body.modules.map((m) => m.name)).toEqual([]);
    const to = await request(app).get(`/api/racks/${rightRack.id}`).set('Cookie', aliceCookie);
    expect(to.body.modules.find((m) => m.name === 'Maths').quantity).toBe(3);
  });
});
