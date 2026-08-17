// Patches as files: written out in names, read back against whatever modules
// the importing user turns out to have.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule } from './helpers.js';

// alice with two modules in her rack, and a patch cabling one into the other.
async function withPatch() {
  const fixture = await createTestApp();
  const { db, app, aliceCookie } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.admin = users.find((u) => u.username === 'admin');
  fixture.alice = users.find((u) => u.username === 'alice');

  fixture.maths = await insertModule(db, fixture.alice.id, {
    manufacturer: 'Make Noise',
    name: 'Maths',
  });
  fixture.lpg = await insertModule(db, fixture.alice.id, { manufacturer: 'Optomix', name: 'LPG' });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'output_jack', 'EOR'), ($1, 'knob', 'RISE'), ($2, 'input_jack', 'CH1 IN')
     RETURNING *`,
    [fixture.maths.id, fixture.lpg.id]
  );
  fixture.components = components;
  fixture.rackId = fixture.maths.rack_id;

  const patch = await request(app)
    .post('/api/patches')
    .set('Cookie', aliceCookie)
    .send({ rack_id: fixture.rackId, name: 'Krell', description: 'the good one' });
  fixture.patch = patch.body;

  const detail = await request(app).get(`/api/patches/${patch.body.id}`).set('Cookie', aliceCookie);
  fixture.instances = detail.body.modules;
  const maths = detail.body.modules.find((m) => m.module_name === 'Maths');
  const lpg = detail.body.modules.find((m) => m.module_name === 'LPG');

  await request(app)
    .post(`/api/patches/${patch.body.id}/cables`)
    .set('Cookie', aliceCookie)
    .send({
      from_patch_module_id: maths.id,
      from_component_id: components[0].id,
      to_patch_module_id: lpg.id,
      to_component_id: components[2].id,
      note: 'slowly',
    });
  await request(app)
    .put(`/api/patches/${patch.body.id}/settings`)
    .set('Cookie', aliceCookie)
    .send({ patch_module_id: maths.id, component_id: components[1].id, value: '2 o’clock' });

  return fixture;
}

const exportPatch = (app, cookie, id) =>
  request(app).get(`/api/patches/${id}/export`).set('Cookie', cookie);

describe('exporting a patch', () => {
  it('writes the patch out in names, not ids', async () => {
    const { app, aliceCookie, patch } = await withPatch();
    const res = await exportPatch(app, aliceCookie, patch.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('Krell.patch.json');

    const doc = JSON.parse(res.text);
    expect(doc).toMatchObject({ format: 'eurorack-assistant.patch', version: 2 });
    expect(doc.patch).toMatchObject({
      name: 'Krell',
      description: 'the good one',
      rack_name: 'main rack',
    });
    expect(doc.patch.modules.map((m) => m.module_name).sort()).toEqual(['LPG', 'Maths']);
    // A cable end is an instance number and a jack name — nothing that only
    // means something in this database.
    const [cable] = doc.patch.cables;
    expect(cable.from.jack).toBe('EOR');
    expect(cable.from.type).toBe('output_jack');
    expect(cable.to.jack).toBe('CH1 IN');
    expect(cable.to.type).toBe('input_jack');
    expect(cable.note).toBe('slowly');
    expect(doc.patch.modules.some((m) => m.ref === cable.from.module)).toBe(true);
    expect(doc.patch.settings).toEqual([
      { module: cable.from.module, control: 'RISE', type: 'knob', value: '2 o’clock' },
    ]);
    expect(JSON.stringify(doc)).not.toContain('module_id');
  });

  it("is the owner's alone, shared or not", async () => {
    const { app, aliceCookie, adminCookie, admin, patch } = await withPatch();
    expect((await exportPatch(app, adminCookie, patch.id)).status).toBe(404);
    // Even a patch shared with them: reading it is one thing, taking a copy
    // away is another.
    await request(app)
      .put(`/api/shares/patch/${patch.id}`)
      .set('Cookie', aliceCookie)
      .send({ user_ids: [admin.id] });
    expect((await request(app).get(`/api/patches/${patch.id}`).set('Cookie', adminCookie)).status).toBe(200);
    expect((await exportPatch(app, adminCookie, patch.id)).status).toBe(404);
  });
});

describe('importing a patch', () => {
  const importPatch = (app, cookie, body) =>
    request(app).post('/api/patches/import').set('Cookie', cookie).send(body);

  it('round-trips a patch back into the same account', async () => {
    const { app, aliceCookie, patch, rackId } = await withPatch();
    const doc = JSON.parse((await exportPatch(app, aliceCookie, patch.id)).text);

    const res = await importPatch(app, aliceCookie, { document: doc, rack_id: rackId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Krell', rack_name: 'main rack', module_count: 2 });
    expect(res.body.unresolved_modules).toEqual([]);
    expect(res.body.id).not.toBe(patch.id);

    // The copy is the same patch: same cable, and its ends resolved back onto
    // the real components rather than surviving as bare names.
    const detail = await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', aliceCookie);
    expect(detail.body.cables).toHaveLength(1);
    const [cable] = detail.body.cables;
    expect(cable.from_component_name).toBe('EOR');
    expect(cable.from_component_id).not.toBeNull();
    expect(cable.to_component_id).not.toBeNull();
    expect(cable.note).toBe('slowly');
    expect(detail.body.settings[0]).toMatchObject({ component_name: 'RISE', value: '2 o’clock' });
    // ...and it points at the instances of the NEW patch, not the old one.
    const instanceIds = detail.body.modules.map((m) => m.id);
    expect(instanceIds).toContain(cable.from_patch_module_id);
  });

  it('resolves identically named components by their exported type', async () => {
    const { app, aliceCookie, db, maths, rackId } = await withPatch();
    const { rows: components } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'ROOT'), ($1, 'knob', 'ROOT') RETURNING id, type`,
      [maths.id]
    );
    const knob = components.find((c) => c.type === 'knob');

    const res = await importPatch(app, aliceCookie, {
      rack_id: rackId,
      document: {
        modules: [{ ref: 1, manufacturer: 'Make Noise', module_name: 'Maths' }],
        settings: [{ module: 1, control: 'ROOT', type: 'knob', value: 'noon' }],
      },
    });

    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', aliceCookie);
    expect(detail.body.settings).toHaveLength(1);
    expect(detail.body.settings[0]).toMatchObject({
      component_id: knob.id,
      component_name: 'ROOT',
      value: 'noon',
    });
  });

  // The whole point of a file: it lands in an account that is not the one it
  // came from.
  it('imports into another account, keeping modules it cannot place by name', async () => {
    const { app, aliceCookie, adminCookie, admin, db, patch, maths } = await withPatch();
    const doc = JSON.parse((await exportPatch(app, aliceCookie, patch.id)).text);
    // The admin has the Maths but not the Optomix.
    await mapModule(db, admin.id, maths.id);

    const res = await importPatch(app, adminCookie, { document: doc });
    expect(res.status).toBe(201);
    expect(res.body.unresolved_modules).toEqual(['Optomix LPG']);
    // No rack of theirs, so it keeps the name it came with.
    expect(res.body.rack_name).toBe('main rack');

    const detail = await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', adminCookie);
    const [cable] = detail.body.cables;
    // The end they have is wired to the real jack; the end they do not have
    // is still in the patch, by name.
    expect(cable.from_component_id).not.toBeNull();
    expect(cable.to_component_id).toBeNull();
    expect(cable.to_component_name).toBe('CH1 IN');
    const lpg = detail.body.modules.find((m) => m.module_name === 'LPG');
    expect(lpg.module_id).toBeNull();
  });

  it('keeps buses, labels, external gear with its ports, and links', async () => {
    const { app, aliceCookie } = await withPatch();
    const document = {
      format: 'eurorack-assistant.patch',
      version: 1,
      patch: {
        name: 'From a friend',
        rack_name: 'their case',
        groups: [{ name: 'Rhythm', description: 'the drums', position: 0 }],
        modules: [
          {
            ref: 1,
            manufacturer: 'Make Noise',
            module_name: 'Maths',
            instance: 1,
            label: 'envelope',
            group: 'Rhythm',
          },
          {
            ref: 2,
            manufacturer: '',
            module_name: 'Ableton',
            external: true,
            ports: [{ name: 'Main L', type: 'input_jack', position: 0 }],
          },
        ],
        cables: [{ from: { module: 1, jack: 'EOR' }, to: { module: 2, jack: 'Main L' } }],
        links: [{ a: 1, b: 2, kind: 'bridge', jacks: [{ a: 'EOR', b: 'Main L' }] }],
      },
    };

    const res = await importPatch(app, aliceCookie, document);
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');
    const daw = detail.body.modules.find((m) => m.module_name === 'Ableton');
    expect(maths.label).toBe('envelope');
    expect(detail.body.groups[0].name).toBe('Rhythm');
    expect(maths.group_id).toBe(detail.body.groups[0].id);
    expect(daw.external).toBe(true);
    // The cable into the DAW found the port declared for it, not a component.
    const [cable] = detail.body.cables;
    expect(cable.to_component_name).toBe('Main L');
    expect(cable.to_component_id).toBe(daw.components.find((c) => c.name === 'Main L').id);
    expect(detail.body.links[0].kind).toBe('bridge');
  });

  it('takes a bare patch body without its envelope', async () => {
    const { app, aliceCookie } = await withPatch();
    const res = await importPatch(app, aliceCookie, {
      name: 'Bare',
      modules: [{ ref: 1, manufacturer: 'Make Noise', module_name: 'Maths' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Bare');
  });

  it('renames on the way in when asked', async () => {
    const { app, aliceCookie, patch, rackId } = await withPatch();
    const doc = JSON.parse((await exportPatch(app, aliceCookie, patch.id)).text);
    const res = await importPatch(app, aliceCookie, {
      document: doc,
      rack_id: rackId,
      name: 'Krell mk2',
    });
    expect(res.body.name).toBe('Krell mk2');
  });

  // A file is a file: it can be anything at all.
  it('refuses a file that is not a patch, and one that contradicts itself', async () => {
    const { app, aliceCookie } = await withPatch();
    const bad = async (body, contains) => {
      const res = await importPatch(app, aliceCookie, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(contains);
    };

    await bad({ format: 'something.else', patch: {} }, 'unknown format');
    await bad({ format: 'eurorack-assistant.patch', version: 99, patch: {} }, 'newer version');
    await bad({ modules: [] }, 'no modules in it');
    await bad({ modules: [{ ref: 1, module_name: '' }] }, 'name is required');
    await bad(
      { modules: [{ ref: 1, module_name: 'Maths' }, { ref: 1, module_name: 'LPG' }] },
      'share the reference'
    );
    await bad(
      {
        modules: [{ ref: 1, module_name: 'Maths' }],
        cables: [{ from: { module: 1, jack: 'EOR' }, to: { module: 4, jack: 'IN' } }],
      },
      'not in the file'
    );
    await bad(
      {
        modules: [{ ref: 1, module_name: 'Maths', group: 'Nowhere' }],
      },
      'the file does not define'
    );
    await bad(
      {
        modules: [{ ref: 1, module_name: 'Maths' }, { ref: 2, module_name: 'LPG' }],
        links: [{ a: 1, b: 2, kind: 'telepathy' }],
      },
      'link kind must be one of'
    );
  });

  it('writes nothing at all when the file is refused', async () => {
    const { app, aliceCookie, db } = await withPatch();
    const before = (await db.query('SELECT count(*) FROM patches')).rows[0].count;
    await importPatch(app, aliceCookie, {
      modules: [{ ref: 1, module_name: 'Maths' }],
      cables: [{ from: { module: 1, jack: 'EOR' }, to: { module: 9, jack: 'IN' } }],
    });
    expect((await db.query('SELECT count(*) FROM patches')).rows[0].count).toBe(before);
  });

  it("will not import into somebody else's rack", async () => {
    const { app, adminCookie, rackId } = await withPatch();
    const res = await importPatch(app, adminCookie, {
      document: { modules: [{ ref: 1, module_name: 'Maths' }] },
      rack_id: rackId,
    });
    expect(res.status).toBe(404);
  });

  it('needs a session', async () => {
    const { app } = await withPatch();
    const res = await request(app).post('/api/patches/import').send({ modules: [] });
    expect(res.status).toBe(401);
  });
});
