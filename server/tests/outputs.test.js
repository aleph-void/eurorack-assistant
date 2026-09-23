import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule } from './helpers.js';
import { patchTextDocument } from '../src/services/patchDocument.js';
import { reachedJacks } from '../src/services/patchDetail.js';

// Fixture: alice's rack holds an oscillator and an output module.
async function withRack() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.vco = await insertModule(db, fixture.alice.id, { manufacturer: 'Make Noise', name: 'STO' });
  fixture.out = await insertModule(db, fixture.alice.id, { manufacturer: 'Intellijel', name: 'Outs' });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'output_jack', 'Sine'),
     ($1, 'knob', 'Shape'),
     ($2, 'input_jack', 'Audio In'),
     ($2, 'knob', 'Level') RETURNING *`,
    [fixture.vco.id, fixture.out.id]
  );
  fixture.sine = components.find((c) => c.name === 'Sine');
  fixture.shape = components.find((c) => c.name === 'Shape');
  fixture.audioIn = components.find((c) => c.name === 'Audio In');
  fixture.level = components.find((c) => c.name === 'Level');
  const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [fixture.alice.id]);
  fixture.rackId = racks[0].id;
  return fixture;
}

const post = (fixture, path, body, cookie = fixture.aliceCookie) =>
  request(fixture.app).post(path).set('Cookie', cookie).send(body);

describe('rack outputs', () => {
  it('marks the jacks sound leaves the rack at, one at a time, and lists them with the rack', async () => {
    const fixture = await withRack();
    const { app, aliceCookie, adminCookie, rackId } = fixture;
    const url = `/api/racks/${rackId}/outputs`;
    // Not a jack, not this rack's module, not this module's component.
    expect((await post(fixture, url, { module_id: fixture.out.id, component_id: fixture.level.id })).status).toBe(400);
    expect((await post(fixture, url, { module_id: 999999, component_id: fixture.audioIn.id })).status).toBe(400);
    expect((await post(fixture, url, { module_id: fixture.vco.id, component_id: fixture.audioIn.id })).status).toBe(400);
    // Somebody else's rack is not there.
    expect((await post(fixture, url, { module_id: fixture.out.id, component_id: fixture.audioIn.id }, adminCookie)).status).toBe(404);

    const added = await post(fixture, url, { module_id: fixture.out.id, component_id: fixture.audioIn.id });
    expect(added.status).toBe(201);
    expect(added.body.outputs).toEqual([
      expect.objectContaining({
        module_id: fixture.out.id,
        manufacturer: 'Intellijel',
        module_name: 'Outs',
        component_id: fixture.audioIn.id,
        component_name: 'Audio In',
        component_type: 'input_jack',
      }),
    ]);
    // Twice is once.
    expect((await post(fixture, url, { module_id: fixture.out.id, component_id: fixture.audioIn.id })).status).toBe(409);

    const listed = await request(app).get(url).set('Cookie', aliceCookie);
    expect(listed.body.outputs).toHaveLength(1);
    const detail = await request(app).get(`/api/racks/${rackId}`).set('Cookie', aliceCookie);
    expect(detail.body.outputs).toHaveLength(1);

    const removed = await request(app)
      .delete(`${url}/${added.body.outputs[0].id}`)
      .set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
    expect(removed.body.outputs).toEqual([]);
    expect((await request(app).delete(`${url}/999`).set('Cookie', aliceCookie)).status).toBe(404);
  });
});

describe('system outputs', () => {
  // Alice's rack, joined to a system — the rack's own exit marked first, so
  // joining can be seen to carry it over.
  async function withSystem({ markRackFirst = false } = {}) {
    const fixture = await withRack();
    if (markRackFirst) {
      await post(fixture, `/api/racks/${fixture.rackId}/outputs`, {
        module_id: fixture.out.id,
        component_id: fixture.audioIn.id,
      });
    }
    fixture.system = (await post(fixture, '/api/systems', { name: 'Studio' })).body;
    await request(fixture.app)
      .put(`/api/racks/${fixture.rackId}/system`)
      .set('Cookie', fixture.aliceCookie)
      .send({ system_id: fixture.system.id });
    return fixture;
  }

  it('marks the jacks sound leaves the system at, naming the rack each stands in', async () => {
    const fixture = await withSystem();
    const { app, aliceCookie, adminCookie, rackId } = fixture;
    const url = `/api/systems/${fixture.system.id}/outputs`;
    const body = { rack_id: rackId, module_id: fixture.out.id, component_id: fixture.audioIn.id };
    // Not a jack, not a rack of this system, not a module of that rack.
    expect((await post(fixture, url, { ...body, component_id: fixture.level.id })).status).toBe(400);
    expect((await post(fixture, url, { ...body, rack_id: 999999 })).status).toBe(400);
    expect((await post(fixture, url, { ...body, module_id: 999999 })).status).toBe(400);
    // Somebody else's system is not there.
    expect((await post(fixture, url, body, adminCookie)).status).toBe(404);

    const added = await post(fixture, url, body);
    expect(added.status).toBe(201);
    expect(added.body.outputs).toEqual([
      expect.objectContaining({
        rack_id: rackId,
        rack_name: expect.any(String),
        module_name: 'Outs',
        component_name: 'Audio In',
        component_type: 'input_jack',
      }),
    ]);
    expect((await post(fixture, url, body)).status).toBe(409);
    const detail = await request(app).get(`/api/systems/${fixture.system.id}`).set('Cookie', aliceCookie);
    expect(detail.body.outputs).toHaveLength(1);

    const removed = await request(app)
      .delete(`${url}/${added.body.outputs[0].id}`)
      .set('Cookie', aliceCookie);
    expect(removed.body.outputs).toEqual([]);
    expect((await request(app).delete(`${url}/999`).set('Cookie', aliceCookie)).status).toBe(404);
  });

  it("is what a patch of the system copies, and a rack in a system is not edited on its own", async () => {
    const fixture = await withSystem();
    const { app, aliceCookie, rackId } = fixture;
    // The rack's own list is closed while it stands in the system.
    const onRack = await post(fixture, `/api/racks/${rackId}/outputs`, {
      module_id: fixture.out.id,
      component_id: fixture.audioIn.id,
    });
    expect(onRack.status).toBe(409);
    await post(fixture, `/api/systems/${fixture.system.id}/outputs`, {
      rack_id: rackId,
      module_id: fixture.out.id,
      component_id: fixture.audioIn.id,
    });
    const patch = (await post(fixture, '/api/patches', { system_id: fixture.system.id, name: 'Room' })).body;
    const detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    expect(detail.outputs.map((o) => o.component_name)).toEqual(['Audio In']);
  });

  it('carries a rack\'s exits in when it joins, and takes them out again when it leaves', async () => {
    const fixture = await withSystem({ markRackFirst: true });
    const { app, aliceCookie, rackId } = fixture;
    const url = `/api/systems/${fixture.system.id}/outputs`;
    let listed = (await request(app).get(url).set('Cookie', aliceCookie)).body;
    expect(listed.outputs.map((o) => o.component_name)).toEqual(['Audio In']);

    await request(app).put(`/api/racks/${rackId}/system`).set('Cookie', aliceCookie).send({ system_id: null });
    listed = (await request(app).get(url).set('Cookie', aliceCookie)).body;
    expect(listed.outputs).toEqual([]);
    // Standing alone again, the rack still has the exit it was marked with.
    const rack = (await request(app).get(`/api/racks/${rackId}`).set('Cookie', aliceCookie)).body;
    expect(rack.outputs.map((o) => o.component_name)).toEqual(['Audio In']);
  });
});

describe('patch outputs', () => {
  async function markedAndPatched(fixture) {
    await post(fixture, `/api/racks/${fixture.rackId}/outputs`, {
      module_id: fixture.out.id,
      component_id: fixture.audioIn.id,
    });
    const patch = (await post(fixture, '/api/patches', { rack_id: fixture.rackId, name: 'Krell' })).body;
    const { rows } = await fixture.db.query(
      'SELECT id, module_id FROM patch_modules WHERE patch_id = $1 ORDER BY id',
      [patch.id]
    );
    const at = new Map(rows.map((r) => [r.module_id, r.id]));
    return { patch, vco: at.get(fixture.vco.id), out: at.get(fixture.out.id) };
  }

  it("copies the rack's outputs into a new patch and says whether the flow reaches them", async () => {
    const fixture = await withRack();
    const { app, aliceCookie } = fixture;
    const { patch, vco, out } = await markedAndPatched(fixture);
    let detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    expect(detail.outputs).toEqual([
      expect.objectContaining({ patch_module_id: out, component_id: fixture.audioIn.id, component_name: 'Audio In', reached: false, live: true }),
    ]);
    // A cable into it, and the flow gets there.
    await post(fixture, `/api/patches/${patch.id}/cables`, {
      from_patch_module_id: vco,
      from_component_id: fixture.sine.id,
      to_patch_module_id: out,
      to_component_id: fixture.audioIn.id,
    });
    detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    expect(detail.outputs[0].reached).toBe(true);
    // The document every question reads says so too.
    const text = patchTextDocument(detail);
    expect(text).toContain('## Where sound leaves the system');
    expect(text).toContain('- Intellijel Outs "Audio In" — signal reaches it');
  });

  it('is edited on the patch: a jack of an instance or of declared gear, never a control', async () => {
    const fixture = await withRack();
    const { app, aliceCookie } = fixture;
    const { patch, vco, out } = await markedAndPatched(fixture);
    const url = `/api/patches/${patch.id}/outputs`;
    expect((await post(fixture, url, { patch_module_id: out, component_id: fixture.level.id })).status).toBe(400);
    expect((await post(fixture, url, { patch_module_id: out, component_id: fixture.audioIn.id })).status).toBe(409);
    // Gear declared inside the patch — the interface — is an exit too.
    const gear = (
      await post(fixture, `/api/patches/${patch.id}/modules`, {
        manufacturer: 'RME',
        module_name: 'Babyface',
        external: true,
      })
    ).body;
    const port = (
      await post(fixture, `/api/patches/${patch.id}/modules/${gear.id}/ports`, {
        name: 'In 1',
        type: 'input_jack',
      })
    ).body;
    const added = await post(fixture, url, { patch_module_id: gear.id, component_id: port.id });
    expect(added.status).toBe(201);
    expect(added.body.outputs.map((o) => o.component_name)).toEqual(['Audio In', 'In 1']);
    // Off the rack's mark and on with the gear's: what the patch keeps is its own.
    const first = added.body.outputs[0];
    const removed = await request(app).delete(`${url}/${first.id}`).set('Cookie', aliceCookie);
    expect(removed.body.outputs.map((o) => o.component_name)).toEqual(['In 1']);
    const { rows } = await fixture.db.query('SELECT id FROM rack_outputs');
    expect(rows).toHaveLength(1);
    expect(vco).toBeTruthy();
  });

  it('survives a clone and an export/import round trip by name', async () => {
    const fixture = await withRack();
    const { app, aliceCookie } = fixture;
    const { patch } = await markedAndPatched(fixture);
    const copy = (await post(fixture, `/api/patches/${patch.id}/clone`, {})).body;
    const cloned = (await request(app).get(`/api/patches/${copy.id}`).set('Cookie', aliceCookie)).body;
    expect(cloned.outputs.map((o) => o.component_name)).toEqual(['Audio In']);
    expect(cloned.outputs[0].patch_module_id).not.toBe(patch.id);

    const exported = (await request(app).get(`/api/patches/${patch.id}/export`).set('Cookie', aliceCookie)).body;
    expect(exported.patch.outputs).toEqual([{ module: expect.any(Number), jack: 'Audio In', type: 'input_jack' }]);
    const imported = (
      await post(fixture, '/api/patches/import', { document: exported, rack_id: fixture.rackId })
    ).body;
    const back = (await request(app).get(`/api/patches/${imported.id}`).set('Cookie', aliceCookie)).body;
    expect(back.outputs).toEqual([
      expect.objectContaining({ component_id: fixture.audioIn.id, component_name: 'Audio In', live: true }),
    ]);
    // A file from before outputs existed is a patch with none.
    delete exported.patch.outputs;
    exported.patch.name = 'Older';
    const older = (await post(fixture, '/api/patches/import', { document: exported })).body;
    expect(older.id).toBeTruthy();
  });
});

describe('reachedJacks', () => {
  it('collects every instance and jack a flow tree passes through', () => {
    const flow = [
      {
        patch_module_id: 1,
        component_id: 10,
        children: [
          { patch_module_id: 2, component_id: 20, children: [] },
          { patch_module_id: 2, component_id: null, children: [{ patch_module_id: 3, component_id: 30, children: [] }] },
        ],
      },
    ];
    expect([...reachedJacks(flow)].sort()).toEqual(['1:10', '2:20', '3:30']);
    expect(reachedJacks(null).size).toBe(0);
  });
});
