import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule, fakeBackend } from './helpers.js';
import { analyzeManualForModule } from '../src/services/manualAnalyzer.js';
import { normalizeComponentValues } from '../src/services/manualNormalize.js';
import { resolveNormalledSignals } from '../src/services/patchSignals.js';
import { buildPatchTopology } from '../src/services/patchTopology.js';
import { freePatchName, isNameConflict } from '../src/services/patchNames.js';

// Fixture: alice has a rack with an analyzed module (jacks + a knob + a
// switch, with valid values recorded) and a second plain module.
async function withPatchFixture() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.admin = users.find((u) => u.username === 'admin');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.module = await insertModule(db, fixture.alice.id, {
    manufacturer: 'Make Noise',
    name: 'Maths',
  });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'input_jack', 'Signal In'),
     ($1, 'output_jack', 'EOR'),
     ($1, 'knob', 'Rise'),
     ($1, 'switch', 'Mode') RETURNING *`,
    [fixture.module.id]
  );
  fixture.input = components.find((c) => c.name === 'Signal In');
  fixture.output = components.find((c) => c.name === 'EOR');
  fixture.knob = components.find((c) => c.name === 'Rise');
  fixture.switch = components.find((c) => c.name === 'Mode');
  await db.query(
    `INSERT INTO component_values (component_id, type, value) VALUES
     ($1, 'min', '0'), ($1, 'max', '10'),
     ($2, 'enum', 'Cycle'), ($2, 'enum', 'Sustain')`,
    [fixture.knob.id, fixture.switch.id]
  );
  fixture.other = await insertModule(db, fixture.alice.id, {
    manufacturer: 'ALM',
    name: 'Pam',
  });
  return fixture;
}

async function createPatch(fixture, body = {}) {
  const { rows: racks } = await fixture.db.query('SELECT id FROM racks WHERE user_id = $1', [
    fixture.alice.id,
  ]);
  const res = await request(fixture.app)
    .post('/api/patches')
    .set('Cookie', fixture.aliceCookie)
    .send({ rack_id: racks[0].id, name: 'Krell', ...body });
  return res;
}

describe('normalizeComponentValues', () => {
  it('stores four or fewer discrete positions as enums', () => {
    expect(normalizeComponentValues({ value_options: [' LP ', 'BP', 'HP', 'bp', ''] })).toEqual([
      { type: 'enum', value: 'LP' },
      { type: 'enum', value: 'BP' },
      { type: 'enum', value: 'HP' },
    ]);
  });

  it('degrades more than four positions to a min/max pair', () => {
    expect(
      normalizeComponentValues({ value_options: ['1', '2', '3', '4', '5', '6'] })
    ).toEqual([
      { type: 'min', value: '1' },
      { type: 'max', value: '6' },
    ]);
  });

  it('stores a continuous range as min/max and tolerates a missing end', () => {
    expect(normalizeComponentValues({ value_min: 0, value_max: 10 })).toEqual([
      { type: 'min', value: '0' },
      { type: 'max', value: '10' },
    ]);
    expect(normalizeComponentValues({ value_min: null, value_max: '5' })).toEqual([
      { type: 'max', value: '5' },
    ]);
    expect(normalizeComponentValues({})).toEqual([]);
  });

  it('prefers discrete positions over a range when both are given', () => {
    expect(
      normalizeComponentValues({ value_min: 0, value_max: 10, value_options: ['off', 'on'] })
    ).toEqual([
      { type: 'enum', value: 'off' },
      { type: 'enum', value: 'on' },
    ]);
  });
});

describe('manual analysis component values', () => {
  it('persists extracted values and rewrites them on re-analysis', async () => {
    const { db, alice } = await withPatchFixture();
    const module = await insertModule(db, alice.id, { manufacturer: 'Mutable', name: 'Ripples' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A filter.',
        components: [
          { type: 'knob', name: 'Cutoff', value_min: 0, value_max: 10 },
          { type: 'switch', name: 'Slope', value_options: ['2-pole', '4-pole'] },
          { type: 'input_jack', name: 'In' },
        ],
        normalizations: [],
      }),
    });
    await analyzeManualForModule(db, backend, module, '/tmp/whatever.pdf');
    const { rows: values } = await db.query(
      `SELECT cv.type, cv.value, mc.name FROM component_values cv
       JOIN module_components mc ON mc.id = cv.component_id
       WHERE mc.module_id = $1 ORDER BY cv.id`,
      [module.id]
    );
    expect(values).toEqual([
      { type: 'min', value: '0', name: 'Cutoff' },
      { type: 'max', value: '10', name: 'Cutoff' },
      { type: 'enum', value: '2-pole', name: 'Slope' },
      { type: 'enum', value: '4-pole', name: 'Slope' },
    ]);

    // Re-analysis replaces the previous inventory and its values.
    const backend2 = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A filter.',
        components: [{ type: 'knob', name: 'Cutoff', value_min: '7 oclock', value_max: '5 oclock' }],
        normalizations: [],
      }),
    });
    await analyzeManualForModule(db, backend2, module, '/tmp/whatever.pdf');
    const { rows: after } = await db.query(
      `SELECT cv.type, cv.value FROM component_values cv
       JOIN module_components mc ON mc.id = cv.component_id
       WHERE mc.module_id = $1 ORDER BY cv.id`,
      [module.id]
    );
    expect(after).toEqual([
      { type: 'min', value: '7 oclock' },
      { type: 'max', value: '5 oclock' },
    ]);
  });
});

describe('component values API', () => {
  it('returns values with the module detail', async () => {
    const { app, aliceCookie, module, knob } = await withPatchFixture();
    const res = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    const knobJson = res.body.components.find((c) => c.id === knob.id);
    expect(knobJson.values.map((v) => [v.type, v.value])).toEqual([
      ['min', '0'],
      ['max', '10'],
    ]);
  });

  it('creates, updates and deletes values with validation', async () => {
    const { app, aliceCookie, module, switch: sw } = await withPatchFixture();
    const base = `/api/modules/${module.id}/components/${sw.id}/values`;

    // Duplicate enum labels (case-insensitive) are rejected.
    const dupe = await request(app)
      .post(base)
      .set('Cookie', aliceCookie)
      .send({ type: 'enum', value: 'cycle' });
    expect(dupe.status).toBe(409);

    const created = await request(app)
      .post(base)
      .set('Cookie', aliceCookie)
      .send({ type: 'enum', value: 'Once', description: 'single shot' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: 'enum', value: 'Once', description: 'single shot' });

    // Bad type / empty value.
    expect(
      (await request(app).post(base).set('Cookie', aliceCookie).send({ type: 'range', value: '1' }))
        .status
    ).toBe(400);
    expect(
      (await request(app).post(base).set('Cookie', aliceCookie).send({ type: 'enum', value: ' ' }))
        .status
    ).toBe(400);

    const updated = await request(app)
      .put(`${base}/${created.body.id}`)
      .set('Cookie', aliceCookie)
      .send({ value: 'One-shot' });
    expect(updated.status).toBe(200);
    expect(updated.body.value).toBe('One-shot');

    // Updating onto an existing label conflicts.
    const clash = await request(app)
      .put(`${base}/${created.body.id}`)
      .set('Cookie', aliceCookie)
      .send({ value: 'Sustain' });
    expect(clash.status).toBe(409);

    const del = await request(app)
      .delete(`${base}/${created.body.id}`)
      .set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
  });

  it('allows a single min and max per component', async () => {
    const { app, aliceCookie, module, knob } = await withPatchFixture();
    const res = await request(app)
      .post(`/api/modules/${module.id}/components/${knob.id}/values`)
      .set('Cookie', aliceCookie)
      .send({ type: 'min', value: '-5' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a min/);
  });

  it('is only open to users who have the module racked', async () => {
    const { app, adminCookie, module, knob } = await withPatchFixture();
    const res = await request(app)
      .post(`/api/modules/${module.id}/components/${knob.id}/values`)
      .set('Cookie', adminCookie)
      .send({ type: 'enum', value: 'x' });
    expect(res.status).toBe(404);
  });
});

// The patch fixture plus a 4-jack mult racked for alice: M1/M2 form group
// '1', M3/M4 are ungrouped (and so count as one group of their own).
async function withMultFixture() {
  const fixture = await withPatchFixture();
  fixture.mult = await insertModule(fixture.db, fixture.alice.id, {
    manufacturer: 'Doepfer',
    name: 'A-180-2',
  });
  const { rows } = await fixture.db.query(
    `INSERT INTO module_components (module_id, type, name, group_label) VALUES
     ($1, 'bidirectional_jack', 'M1', '1'),
     ($1, 'bidirectional_jack', 'M2', '1'),
     ($1, 'bidirectional_jack', 'M3', NULL),
     ($1, 'bidirectional_jack', 'M4', NULL) RETURNING *`,
    [fixture.mult.id]
  );
  fixture.multJacks = Object.fromEntries(rows.map((r) => [r.name, r]));
  return fixture;
}

describe('normalled connections in patches', () => {
  // The patch fixture plus a filter whose In 2 is normalled to In 1, and
  // whose In 1 is normalled to an internal noise source.
  async function withNormalledFixture() {
    const fixture = await withPatchFixture();
    const { db } = fixture;
    fixture.filter = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Mutable',
      name: 'Ripples',
    });
    const { rows } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'In 1'), ($1, 'input_jack', 'In 2'), ($1, 'output_jack', 'LP') RETURNING *`,
      [fixture.filter.id]
    );
    fixture.filterJacks = Object.fromEntries(rows.map((r) => [r.name, r]));
    await db.query(
      `INSERT INTO component_normalizations
         (module_id, target_component_id, source_component_id, source_label, kind) VALUES
       ($1, $2, $3, NULL, 'input'),
       ($1, $3, NULL, 'white noise', 'internal')`,
      [fixture.filter.id, fixture.filterJacks['In 2'].id, fixture.filterJacks['In 1'].id]
    );
    return fixture;
  }

  it('marks normals active or overridden and traces chains to the arriving signal', async () => {
    const fixture = await withNormalledFixture();
    const { app, aliceCookie, output, filterJacks } = fixture;
    const patch = (await createPatch(fixture)).body;
    const getDetail = async () =>
      (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;

    let detail = await getDetail();
    const ripples = detail.modules.find((m) => m.module_name === 'Ripples');
    const maths = detail.modules.find((m) => m.module_name === 'Maths');
    const norm = (d, targetName) =>
      d.normalizations.find((n) => n.target_component_name === targetName);

    // A patch is what is plugged in: a module no cable reaches has no
    // normalled connections to report here — they are the module's business
    // until the patch uses it.
    expect(detail.normalizations).toEqual([]);

    // Its output into Maths brings Ripples into the patch without touching
    // its inputs. Both its normals are then active, and In 2's chained
    // signal is the internal source feeding In 1.
    const inUse = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: ripples.id,
        from_component_id: filterJacks['LP'].id,
        to_patch_module_id: maths.id,
        to_component_id: fixture.input.id,
      });
    expect(inUse.status).toBe(201);
    detail = await getDetail();
    expect(detail.normalizations).toHaveLength(2);
    expect(norm(detail, 'In 1')).toMatchObject({
      active: true,
      signals: [{ kind: 'internal', label: 'white noise', via: [] }],
    });
    expect(norm(detail, 'In 2')).toMatchObject({
      active: true,
      signals: [{ kind: 'internal', label: 'white noise', via: ['In 1'] }],
    });

    // EOR → In 1: In 1's own normal is overridden, and In 2 now chains to the
    // patched cable instead of the internal source.
    const cable = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: ripples.id,
        to_component_id: filterJacks['In 1'].id,
      });
    expect(cable.status).toBe(201);
    detail = await getDetail();
    expect(norm(detail, 'In 1')).toMatchObject({
      active: false,
      overriding_cable_id: cable.body.id,
      signals: [],
    });
    expect(norm(detail, 'In 2')).toMatchObject({
      active: true,
      signals: [
        {
          kind: 'cable',
          cable_id: cable.body.id,
          from_component_name: 'EOR',
          via: ['In 1'],
        },
      ],
    });

    // EOR → In 2 as well: In 2's normal breaks too.
    await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: ripples.id,
        to_component_id: filterJacks['In 2'].id,
      });
    detail = await getDetail();
    expect(norm(detail, 'In 2').active).toBe(false);
  });

  it('survives normalization cycles and dead ends', () => {
    const components = [
      { id: 1, type: 'input_jack', name: 'A' },
      { id: 2, type: 'input_jack', name: 'B' },
    ];
    // A and B normalled to each other — a cycle with no signal anywhere.
    const rows = resolveNormalledSignals(
      buildPatchTopology({
        patchModules: [{ id: 10, module_id: 1 }],
        componentsByModule: new Map([[1, components]]),
        normalizationsByModule: new Map([
          [
            1,
            [
              { id: 1, target_component_id: 1, source_component_id: 2, source_label: null, kind: 'input' },
              { id: 2, target_component_id: 2, source_component_id: 1, source_label: null, kind: 'input' },
            ],
          ],
        ]),
        // The patch dials this instance in, which is what puts it in play —
        // normals are reported for the modules a patch uses.
        settings: [{ patch_module_id: 10, component_id: 99, value: 'noon' }],
        cables: [],
      })
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.active).toBe(true);
      expect(row.signals.every((s) => s.kind === 'none')).toBe(true);
    }
  });
});

describe('mult (bidirectional jack) support', () => {
  it('extracts bidirectional jacks and their groups from the manual', async () => {
    const { db, alice } = await withPatchFixture();
    const module = await insertModule(db, alice.id, { manufacturer: 'Intellijel', name: 'Mult' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A dual buffered mult... no wait, passive.',
        components: [
          { type: 'bidirectional_jack', name: 'A1', group: '1' },
          { type: 'bidirectional_jack', name: 'A2', group: '1' },
          { type: 'bidirectional_jack', name: 'B1', group: '2' },
        ],
        normalizations: [],
      }),
    });
    await analyzeManualForModule(db, backend, module, '/tmp/whatever.pdf');
    const { rows } = await db.query(
      'SELECT name, type, group_label FROM module_components WHERE module_id = $1 ORDER BY id',
      [module.id]
    );
    expect(rows).toEqual([
      { name: 'A1', type: 'bidirectional_jack', group_label: '1' },
      { name: 'A2', type: 'bidirectional_jack', group_label: '1' },
      { name: 'B1', type: 'bidirectional_jack', group_label: '2' },
    ]);
  });

  it('lets a racked user reclassify a component into a mult jack', async () => {
    const { app, aliceCookie, adminCookie, module, input } = await withPatchFixture();
    const res = await request(app)
      .put(`/api/modules/${module.id}/components/${input.id}`)
      .set('Cookie', aliceCookie)
      .send({ type: 'bidirectional_jack', group_label: ' 1 ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'bidirectional_jack', group_label: '1' });

    expect(
      (
        await request(app)
          .put(`/api/modules/${module.id}/components/${input.id}`)
          .set('Cookie', aliceCookie)
          .send({ type: 'patch_point' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/modules/${module.id}/components/${input.id}`)
          .set('Cookie', aliceCookie)
          .send({})
      ).status
    ).toBe(400);
    // Admin doesn't have the module racked → shared edits are closed to them.
    expect(
      (
        await request(app)
          .put(`/api/modules/${module.id}/components/${input.id}`)
          .set('Cookie', adminCookie)
          .send({ type: 'input_jack' })
      ).status
    ).toBe(404);
  });

  it('enforces one input per mult group, decided by cable direction', async () => {
    const fixture = await withMultFixture();
    const { app, aliceCookie, output, input, multJacks } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');
    const mult = detail.body.modules.find((m) => m.module_name === 'A-180-2');
    expect(mult.components.find((c) => c.name === 'M1').group_label).toBe('1');

    const plug = (fromPm, fromComponent, toPm, toComponent) =>
      request(app).post(`/api/patches/${patch.id}/cables`).set('Cookie', aliceCookie).send({
        from_patch_module_id: fromPm.id,
        from_component_id: fromComponent.id,
        to_patch_module_id: toPm.id,
        to_component_id: toComponent.id,
      });

    // EOR → M1 makes M1 the input of group 1.
    expect((await plug(maths, output, mult, multJacks.M1)).status).toBe(201);
    // Group 1 cannot take a second input.
    const second = await plug(maths, output, mult, multJacks.M2);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already takes its input at 'M1'/);
    // The input jack cannot also send a copy out.
    const fromInput = await plug(mult, multJacks.M1, maths, input);
    expect(fromInput.status).toBe(409);
    expect(fromInput.body.error).toMatch(/already the mult group's input/);
    // The other group-1 jack carries the copy out.
    expect((await plug(mult, multJacks.M2, maths, input)).status).toBe(201);
    // ...and once it does, nothing can be plugged INTO it.
    const intoCopy = await plug(maths, output, mult, multJacks.M2);
    expect(intoCopy.status).toBe(409);
    expect(intoCopy.body.error).toMatch(/carrying a copy out/);

    // The ungrouped jacks are their own group, independent of group 1.
    expect((await plug(maths, output, mult, multJacks.M3)).status).toBe(201);
    // A cable between two jacks of the same group does nothing.
    const loop = await plug(mult, multJacks.M4, mult, multJacks.M3);
    expect(loop.status).toBe(400);
    expect(loop.body.error).toMatch(/same mult group/);
  });
});

describe('signal flow', () => {
  // Mult fixture plus a 2-channel mixer whose channels both route to the mix
  // output (a merge point).
  async function withFlowFixture() {
    const fixture = await withMultFixture();
    const { db } = fixture;
    fixture.mixer = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Happy Nerding',
      name: '3xMIA',
    });
    const { rows } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'Ch 1'), ($1, 'input_jack', 'Ch 2'), ($1, 'output_jack', 'Mix Out') RETURNING *`,
      [fixture.mixer.id]
    );
    fixture.mixerJacks = Object.fromEntries(rows.map((r) => [r.name, r]));
    await db.query(
      `INSERT INTO component_routes (module_id, input_component_id, output_component_id) VALUES
       ($1, $2, $4), ($1, $3, $4)`,
      [
        fixture.mixer.id,
        fixture.mixerJacks['Ch 1'].id,
        fixture.mixerJacks['Ch 2'].id,
        fixture.mixerJacks['Mix Out'].id,
      ]
    );
    return fixture;
  }

  it('follows a generator through mult copies, cables and module internals, flagging merges', async () => {
    const fixture = await withFlowFixture();
    const { app, aliceCookie, output, multJacks, mixerJacks } = fixture;
    const patch = (await createPatch(fixture)).body;
    let detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;
    const maths = detail.modules.find((m) => m.module_name === 'Maths');
    const mult = detail.modules.find((m) => m.module_name === 'A-180-2');
    const mixer = detail.modules.find((m) => m.module_name === '3xMIA');

    const plug = (fromPm, fromComponent, toPm, toComponent) =>
      request(app).post(`/api/patches/${patch.id}/cables`).set('Cookie', aliceCookie).send({
        from_patch_module_id: fromPm.id,
        from_component_id: fromComponent.id,
        to_patch_module_id: toPm.id,
        to_component_id: toComponent.id,
      });
    // EOR splits: into the mult (M1 becomes the group input) and, stacked,
    // straight into mixer channel 2. The mult copy M2 feeds channel 1.
    expect((await plug(maths, output, mult, multJacks.M1)).status).toBe(201);
    expect((await plug(mult, multJacks.M2, mixer, mixerJacks['Ch 1'])).status).toBe(201);
    expect((await plug(maths, output, mixer, mixerJacks['Ch 2'])).status).toBe(201);

    detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    // EOR is the only signal source (the mixer's Mix Out is fed by routes,
    // so it is not a generator).
    expect(detail.flow).toHaveLength(1);
    const root = detail.flow[0];
    expect(root).toMatchObject({ name: 'EOR', via: null, merge: false });
    expect(root.children.map((c) => [c.via, c.name]).sort()).toEqual([
      ['cable', 'Ch 2'],
      ['cable', 'M1'],
    ]);
    // Branch 1: mult copy → mixer channel 1 → internal route → Mix Out.
    const m1 = root.children.find((c) => c.name === 'M1');
    expect(m1.children).toHaveLength(1);
    expect(m1.children[0]).toMatchObject({ via: 'mult', name: 'M2' });
    const ch1 = m1.children[0].children[0];
    expect(ch1).toMatchObject({ via: 'cable', name: 'Ch 1' });
    expect(ch1.children[0]).toMatchObject({ via: 'route', name: 'Mix Out', merge: true });
    // Branch 2 reaches the same merge point.
    const ch2 = root.children.find((c) => c.name === 'Ch 2');
    expect(ch2.children[0]).toMatchObject({ via: 'route', name: 'Mix Out', merge: true });
  });

  it('cuts feedback loops instead of recursing forever', async () => {
    const fixture = await withPatchFixture();
    const { db, app, aliceCookie, output } = fixture;
    const fx = await insertModule(db, fixture.alice.id, { manufacturer: 'Make Noise', name: 'Echo' });
    const { rows } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'In A'), ($1, 'input_jack', 'In B'), ($1, 'output_jack', 'Out') RETURNING *`,
      [fx.id]
    );
    const jacks = Object.fromEntries(rows.map((r) => [r.name, r]));
    await db.query(
      `INSERT INTO component_routes (module_id, input_component_id, output_component_id) VALUES
       ($1, $2, $4), ($1, $3, $4)`,
      [fx.id, jacks['In A'].id, jacks['In B'].id, jacks.Out.id]
    );
    const patch = (await createPatch(fixture)).body;
    let detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;
    const maths = detail.modules.find((m) => m.module_name === 'Maths');
    const echo = detail.modules.find((m) => m.module_name === 'Echo');
    const plug = (fromPm, fromComponent, toPm, toComponent) =>
      request(app).post(`/api/patches/${patch.id}/cables`).set('Cookie', aliceCookie).send({
        from_patch_module_id: fromPm.id,
        from_component_id: fromComponent.id,
        to_patch_module_id: toPm.id,
        to_component_id: toComponent.id,
      });
    // EOR drives In A; the output feeds back into In B.
    expect((await plug(maths, output, echo, jacks['In A'])).status).toBe(201);
    expect((await plug(echo, jacks.Out, echo, jacks['In B'])).status).toBe(201);

    detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    expect(detail.flow).toHaveLength(1);
    // EOR → In A → Out → In B → Out(cycle, walk stops)
    const out = detail.flow[0].children[0].children[0];
    expect(out).toMatchObject({ name: 'Out', via: 'route', merge: true, cycle: false });
    const loopedOut = out.children[0].children[0];
    expect(loopedOut).toMatchObject({ name: 'Out', via: 'route', cycle: true });
    expect(loopedOut.children).toEqual([]);
  });

  it('extracts internal routes from the manual, dropping unresolvable ones', async () => {
    const { db, alice } = await withPatchFixture();
    const module = await insertModule(db, alice.id, { manufacturer: 'Mutable', name: 'Veils' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A quad VCA.',
        components: [
          { type: 'input_jack', name: 'In 1' },
          { type: 'output_jack', name: 'Out 1' },
          { type: 'knob', name: 'Gain 1' },
        ],
        normalizations: [],
        routes: [
          { input: 'In 1', output: 'Out 1', description: 'VCA 1 signal path' },
          { input: 'Gain 1', output: 'Out 1' }, // not an input jack — dropped
          { input: 'In 9', output: 'Out 1' }, // unknown name — dropped
        ],
      }),
    });
    await analyzeManualForModule(db, backend, module, '/tmp/whatever.pdf');
    const { rows } = await db.query(
      `SELECT ci.name AS input, co.name AS output, cr.description
       FROM component_routes cr
       JOIN module_components ci ON ci.id = cr.input_component_id
       JOIN module_components co ON co.id = cr.output_component_id
       WHERE cr.module_id = $1`,
      [module.id]
    );
    expect(rows).toEqual([{ input: 'In 1', output: 'Out 1', description: 'VCA 1 signal path' }]);
  });

  it('lets racked users add and remove routes with validation', async () => {
    const { app, aliceCookie, module, input, output, knob } = await withPatchFixture();
    const created = await request(app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', aliceCookie)
      .send({ input_component_id: input.id, output_component_id: output.id });
    expect(created.status).toBe(201);

    // Route rows surface in the module detail.
    const detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.routes).toHaveLength(1);
    expect(detail.body.routes[0]).toMatchObject({
      input_component_id: input.id,
      output_component_id: output.id,
    });

    const dupe = await request(app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', aliceCookie)
      .send({ input_component_id: input.id, output_component_id: output.id });
    expect(dupe.status).toBe(409);
    const badInput = await request(app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', aliceCookie)
      .send({ input_component_id: knob.id, output_component_id: output.id });
    expect(badInput.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/modules/${module.id}/routes/${created.body.id}`)
      .set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
  });
});

describe('routing switches', () => {
  // A bidirectional 4-step switch (Doepfer A-151 style): common 'O/I' plus
  // steps 'I/O 1'..'I/O 4', all bidirectional jacks with NO mult group.
  async function withSwitchFixture() {
    const fixture = await withPatchFixture();
    const { db } = fixture;
    fixture.switchModule = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Doepfer',
      name: 'A-151',
    });
    const { rows } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'bidirectional_jack', 'O/I'),
       ($1, 'bidirectional_jack', 'I/O 1'),
       ($1, 'bidirectional_jack', 'I/O 2'),
       ($1, 'input_jack', 'Clock') RETURNING *`,
      [fixture.switchModule.id]
    );
    fixture.switchJacks = Object.fromEntries(rows.map((r) => [r.name, r]));
    const { rows: sections } = await db.query(
      `INSERT INTO component_switches (module_id, name, common_component_id)
       VALUES ($1, 'Section 1', $2) RETURNING *`,
      [fixture.switchModule.id, fixture.switchJacks['O/I'].id]
    );
    fixture.switchSection = sections[0];
    await db.query(
      `INSERT INTO component_switch_steps (switch_id, component_id, position)
       VALUES ($1, $2, 1), ($1, $3, 2)`,
      [
        fixture.switchSection.id,
        fixture.switchJacks['I/O 1'].id,
        fixture.switchJacks['I/O 2'].id,
      ]
    );
    // A second destination module so switched signals go somewhere.
    fixture.sink = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Mutable',
      name: 'Ripples',
    });
    const { rows: sinkRows } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'In A'), ($1, 'input_jack', 'In B'), ($1, 'output_jack', 'Out A') RETURNING *`,
      [fixture.sink.id]
    );
    fixture.sinkJacks = Object.fromEntries(sinkRows.map((r) => [r.name, r]));
    return fixture;
  }

  async function switchPatch(fixture) {
    const { app, aliceCookie } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie))
      .body;
    const plug = (fromPm, fromComponent, toPm, toComponent) =>
      request(app).post(`/api/patches/${patch.id}/cables`).set('Cookie', aliceCookie).send({
        from_patch_module_id: fromPm.id,
        from_component_id: fromComponent.id,
        to_patch_module_id: toPm.id,
        to_component_id: toComponent.id,
      });
    return {
      patch,
      plug,
      refresh: async () =>
        (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body,
      maths: detail.modules.find((m) => m.module_name === 'Maths'),
      sw: detail.modules.find((m) => m.module_name === 'A-151'),
      sink: detail.modules.find((m) => m.module_name === 'Ripples'),
    };
  }

  it('extracts switch sections from the manual and exposes them on the module', async () => {
    const { db, app, aliceCookie, alice } = await withPatchFixture();
    const module = await insertModule(db, alice.id, { manufacturer: 'Doepfer', name: 'A-151b' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'A sequential switch.',
        components: [
          { type: 'bidirectional_jack', name: 'O/I' },
          { type: 'bidirectional_jack', name: 'I/O 1' },
          { type: 'bidirectional_jack', name: 'I/O 2' },
          { type: 'input_jack', name: 'Clock' },
        ],
        normalizations: [],
        routes: [],
        switches: [
          { name: 'Section 1', common: 'O/I', steps: ['I/O 1', 'I/O 2', 'O/I', 'nope'] },
          { common: 'missing', steps: ['I/O 1'] },
        ],
      }),
    });
    await analyzeManualForModule(db, backend, module, '/tmp/whatever.pdf');
    const detail = await request(app).get(`/api/modules/${module.id}`).set('Cookie', aliceCookie);
    expect(detail.body.switches).toHaveLength(1);
    const section = detail.body.switches[0];
    const nameOf = (id) => detail.body.components.find((c) => c.id === id).name;
    expect(section.name).toBe('Section 1');
    expect(nameOf(section.common_component_id)).toBe('O/I');
    // The common repeated as a step, and unresolvable names, are dropped.
    expect(section.step_component_ids.map(nameOf)).toEqual(['I/O 1', 'I/O 2']);
  });

  it('lets racked users record and remove switch sections with validation', async () => {
    const fixture = await withSwitchFixture();
    const { app, aliceCookie, switchModule, switchJacks } = fixture;
    const base = `/api/modules/${switchModule.id}/switches`;
    // The existing section already claims O/I as its common.
    const dupe = await request(app)
      .post(base)
      .set('Cookie', aliceCookie)
      .send({
        common_component_id: switchJacks['O/I'].id,
        step_component_ids: [switchJacks['I/O 1'].id, switchJacks['I/O 2'].id],
      });
    expect(dupe.status).toBe(409);
    // Fewer than two distinct steps is not a switch.
    const tooFew = await request(app)
      .post(base)
      .set('Cookie', aliceCookie)
      .send({
        common_component_id: switchJacks['I/O 1'].id,
        step_component_ids: [switchJacks['I/O 1'].id, switchJacks['I/O 2'].id],
      });
    expect(tooFew.status).toBe(400);

    const created = await request(app)
      .post(base)
      .set('Cookie', aliceCookie)
      .send({
        common_component_id: switchJacks['I/O 1'].id,
        step_component_ids: [switchJacks['I/O 2'].id, switchJacks.Clock.id],
        name: 'Section 2',
      });
    expect(created.status).toBe(201);
    expect(created.body.step_component_ids).toHaveLength(2);
    expect(
      (await request(app).delete(`${base}/${created.body.id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);
  });

  it('distributes one input across switch steps (1-to-many)', async () => {
    const fixture = await withSwitchFixture();
    const { output, switchJacks, sinkJacks } = fixture;
    const { plug, refresh, maths, sw, sink } = await switchPatch(fixture);

    // EOR → the common; both steps cable onward to the sink.
    expect((await plug(maths, output, sw, switchJacks['O/I'])).status).toBe(201);
    expect((await plug(sw, switchJacks['I/O 1'], sink, sinkJacks['In A'])).status).toBe(201);
    expect((await plug(sw, switchJacks['I/O 2'], sink, sinkJacks['In B'])).status).toBe(201);

    const detail = await refresh();
    expect(detail.flow).toHaveLength(1);
    const common = detail.flow[0].children[0];
    expect(common).toMatchObject({ name: 'O/I', via: 'cable' });
    // Both steps hang off the common as alternatives, not simultaneous copies.
    expect(common.children.map((c) => [c.name, c.via, c.switched]).sort()).toEqual([
      ['I/O 1', 'switch', true],
      ['I/O 2', 'switch', true],
    ]);
    expect(common.children[0].children[0].name).toMatch(/^In [AB]$/);
  });

  it('selects one of many inputs onto the common (many-to-one) without mult 409s', async () => {
    const fixture = await withSwitchFixture();
    const { output, switchJacks, sinkJacks } = fixture;
    const { plug, refresh, maths, sw, sink } = await switchPatch(fixture);

    // Two sources into two steps — the mult one-input-per-group rule must NOT
    // fire here, because a switch section is not a mult.
    expect((await plug(maths, output, sw, switchJacks['I/O 1'])).status).toBe(201);
    const secondInput = await plug(sink, sinkJacks['Out A'], sw, switchJacks['I/O 2']);
    expect(secondInput.status).toBe(201);
    // The common carries the selected signal onward.
    expect((await plug(sw, switchJacks['O/I'], sink, sinkJacks['In A'])).status).toBe(201);

    const detail = await refresh();
    // Two sources: EOR and the sink's own output.
    expect(detail.flow).toHaveLength(2);
    const fromEor = detail.flow.find((f) => f.name === 'EOR');
    const step = fromEor.children[0];
    expect(step).toMatchObject({ name: 'I/O 1', via: 'cable' });
    const common = step.children[0];
    // Convergence through switch edges only = selection, not mixing.
    expect(common).toMatchObject({
      name: 'O/I',
      via: 'switch',
      switched: true,
      switched_merge: true,
      merge: false,
    });
  });

  // The picture cannot tell which way a switch's bidirectional jacks run
  // without knowing which jacks make up the section, so the patch payload
  // says: the common jack, and the steps it selects between, on instances.
  it('names its switch sections on the patch, resolved onto instances', async () => {
    const fixture = await withSwitchFixture();
    const { switchJacks } = fixture;
    const { refresh, sw } = await switchPatch(fixture);
    const detail = await refresh();
    expect(detail.switches).toHaveLength(1);
    expect(detail.switches[0]).toMatchObject({
      name: 'Section 1',
      patch_module_id: sw.id,
      common_patch_module_id: sw.id,
      common_component_id: switchJacks['O/I'].id,
    });
    expect(detail.switches[0].steps).toEqual([
      { patch_module_id: sw.id, component_id: switchJacks['I/O 1'].id },
      { patch_module_id: sw.id, component_id: switchJacks['I/O 2'].id },
    ]);
  });

  it('keeps mult rules for mult jacks while exempting switch jacks', async () => {
    const fixture = await withMultFixture();
    const { app, aliceCookie, output, multJacks } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie))
      .body;
    const maths = detail.modules.find((m) => m.module_name === 'Maths');
    const mult = detail.modules.find((m) => m.module_name === 'A-180-2');
    const plug = (toComponent) =>
      request(app).post(`/api/patches/${patch.id}/cables`).set('Cookie', aliceCookie).send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: mult.id,
        to_component_id: toComponent.id,
      });
    expect((await plug(multJacks.M1)).status).toBe(201);
    // Still a genuine mult group → second input rejected.
    expect((await plug(multJacks.M2)).status).toBe(409);
  });
});

describe('patches API', () => {
  it('creates a patch snapshotting the rack, one row per module instance', async () => {
    const fixture = await withPatchFixture();
    const { db, app, aliceCookie, alice } = fixture;
    // Two of the same module in the rack → two instances in the snapshot.
    await db.query('UPDATE rack_modules SET quantity = 2 WHERE module_id = $1', [
      fixture.module.id,
    ]);
    const res = await createPatch(fixture, { description: 'self-generating' });
    expect(res.status).toBe(201);
    expect(res.body.module_count).toBe(3);
    expect(res.body.rack_name).toBe('main rack');

    const detail = await request(app)
      .get(`/api/patches/${res.body.id}`)
      .set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    const maths = detail.body.modules.filter((m) => m.module_name === 'Maths');
    expect(maths.map((m) => m.instance)).toEqual([1, 2]);
    expect(maths[0].live).toBe(true);
    expect(maths[0].components).toHaveLength(4);
    const knob = maths[0].components.find((c) => c.name === 'Rise');
    expect(knob.values.map((v) => v.type)).toEqual(['min', 'max']);

    // Patches are private: the admin cannot see it.
    expect(
      (await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', fixture.adminCookie))
        .status
    ).toBe(404);
    void alice;
  });

  it('validates patch creation', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie, adminCookie } = fixture;
    expect((await createPatch(fixture, { name: ' ' })).status).toBe(400);
    // Someone else's rack 404s.
    const { rows: racks } = await fixture.db.query('SELECT id FROM racks WHERE user_id = $1', [
      fixture.alice.id,
    ]);
    const foreign = await request(app)
      .post('/api/patches')
      .set('Cookie', adminCookie)
      .send({ rack_id: racks[0].id, name: 'steal' });
    expect(foreign.status).toBe(404);
    // An empty rack cannot be patched.
    const empty = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .send({ name: 'empty case' });
    const res = await request(app)
      .post('/api/patches')
      .set('Cookie', aliceCookie)
      .send({ rack_id: empty.body.id, name: 'nothing' });
    expect(res.status).toBe(400);
  });

  it('lists patches with counts, renames and deletes them', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const created = await createPatch(fixture);
    const list = await request(app).get('/api/patches').set('Cookie', aliceCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Krell', module_count: 2, cable_count: 0 });

    const renamed = await request(app)
      .put(`/api/patches/${created.body.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Krell II', description: 'v2' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Krell II', description: 'v2' });

    const del = await request(app)
      .delete(`/api/patches/${created.body.id}`)
      .set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
    expect((await request(app).get('/api/patches').set('Cookie', aliceCookie)).body).toHaveLength(0);
  });

  it('plugs cables from output jacks into input jacks only', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie, input, output, knob } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');

    // EOR → Signal In on the same module instance (self-patching is normal).
    const cable = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: maths.id,
        to_component_id: input.id,
      });
    expect(cable.status).toBe(201);
    expect(cable.body).toMatchObject({
      from_component_name: 'EOR',
      to_component_name: 'Signal In',
    });

    // The input is now taken.
    const second = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: maths.id,
        to_component_id: input.id,
      });
    expect(second.status).toBe(409);

    // Wrong directions / foreign components.
    const backwards = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: input.id,
        to_patch_module_id: maths.id,
        to_component_id: input.id,
      });
    expect(backwards.status).toBe(400);
    const intoKnob = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: maths.id,
        to_component_id: knob.id,
      });
    expect(intoKnob.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/patches/${patch.id}/cables/${cable.body.id}`)
      .set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
  });

  it('upserts and deletes settings for non-jack components', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie, knob, input } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');

    const set = await request(app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', aliceCookie)
      .send({ patch_module_id: maths.id, component_id: knob.id, value: '7' });
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ component_name: 'Rise', value: '7' });

    // Setting the same control again updates in place.
    const again = await request(app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', aliceCookie)
      .send({ patch_module_id: maths.id, component_id: knob.id, value: '9' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(set.body.id);
    expect(again.body.value).toBe('9');

    // Jacks take cables, not settings; empty values are rejected.
    expect(
      (
        await request(app)
          .put(`/api/patches/${patch.id}/settings`)
          .set('Cookie', aliceCookie)
          .send({ patch_module_id: maths.id, component_id: input.id, value: 'x' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/patches/${patch.id}/settings`)
          .set('Cookie', aliceCookie)
          .send({ patch_module_id: maths.id, component_id: knob.id, value: ' ' })
      ).status
    ).toBe(400);

    const removed = await request(app)
      .delete(`/api/patches/${patch.id}/settings/${set.body.id}`)
      .set('Cookie', aliceCookie);
    expect(removed.status).toBe(200);
  });

  it("corrects an instance's manufacturer and module name, refusing empty ones", async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = async () =>
      (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    const maths = (await detail()).modules.find((m) => m.module_name === 'Maths');
    const rename = (body) =>
      request(app)
        .put(`/api/patches/${patch.id}/modules/${maths.id}`)
        .set('Cookie', aliceCookie)
        .send(body);

    const renamed = await rename({ manufacturer: '  Make Noise  ', module_name: ' Maths 2  ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.manufacturer).toBe('Make Noise');
    expect(renamed.body.module_name).toBe('Maths 2');
    // The live module behind the instance keeps its own name and components.
    const after = (await detail()).modules.find((m) => m.id === maths.id);
    expect(after.module_name).toBe('Maths 2');
    expect(after.live).toBe(true);
    expect(after.components).toHaveLength(4);

    // Neither name may be blanked, whitespace included.
    for (const body of [{ manufacturer: '' }, { manufacturer: '   ' }, { module_name: '' }]) {
      const bad = await rename(body);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/cannot be empty/);
    }
    const unchanged = (await detail()).modules.find((m) => m.id === maths.id);
    expect(unchanged.manufacturer).toBe('Make Noise');
    expect(unchanged.module_name).toBe('Maths 2');

    const nothing = await rename({});
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatch(/label, group_id, manufacturer or module_name/);
  });

  it('keeps showing the snapshot after the module moves to another rack', async () => {
    const fixture = await withPatchFixture();
    const { db, app, aliceCookie, alice } = fixture;
    const patch = (await createPatch(fixture)).body;

    // Move Maths into a different rack (the patch's rack no longer holds it).
    await mapModule(db, alice.id, fixture.module.id, { rack: 'travel case' });
    const { rows: racks } = await db.query(
      "SELECT id FROM racks WHERE user_id = $1 AND name = 'main rack'",
      [alice.id]
    );
    await db.query('DELETE FROM rack_modules WHERE rack_id = $1 AND module_id = $2', [
      racks[0].id,
      fixture.module.id,
    ]);

    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');
    expect(maths).toBeTruthy();
    expect(maths.live).toBe(true);
    expect(maths.components).toHaveLength(4);
  });

  it('keeps showing cables by name once the module record itself is gone', async () => {
    const fixture = await withPatchFixture();
    const { db, app, aliceCookie, input, output } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    const maths = detail.body.modules.find((m) => m.module_name === 'Maths');
    await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: maths.id,
        to_component_id: input.id,
      });

    // Removing the module from every rack keeps the shared record, so the
    // patch still reads its live components…
    const res = await request(app)
      .delete(`/api/modules/${fixture.module.id}`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(await db.models.Module.findByPk(fixture.module.id)).not.toBeNull();
    const unracked = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    expect(unracked.body.modules.find((m) => m.module_name === 'Maths').live).toBe(true);

    // …and falls back to the snapshot only if the record itself ever goes
    // (nothing in the app deletes one; the schema still allows it).
    await db.query('DELETE FROM modules WHERE id = $1', [fixture.module.id]);

    const after = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    expect(after.status).toBe(200);
    const gone = after.body.modules.find((m) => m.module_name === 'Maths');
    expect(gone.live).toBe(false);
    expect(gone.manufacturer).toBe('Make Noise');
    expect(gone.components).toEqual([]);
    // The cable still reads EOR → Signal In from its snapshot names.
    expect(after.body.cables).toHaveLength(1);
    expect(after.body.cables[0]).toMatchObject({
      from_component_name: 'EOR',
      to_component_name: 'Signal In',
    });
  });

  it('validates added instances and numbers repeat gear by name', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const patch = (await createPatch(fixture)).body;
    const post = (body) =>
      request(app).post(`/api/patches/${patch.id}/modules`).set('Cookie', aliceCookie).send(body);

    // Only modules the user actually has racked can be referenced live.
    const unracked = await post({ module_id: 99999 });
    expect(unracked.status).toBe(400);
    expect(unracked.body.error).toMatch(/one of your racks/);

    const nameless = await post({ external: true });
    expect(nameless.status).toBe(400);
    expect(nameless.body.error).toMatch(/name for the module or piece of gear/);

    // External gear ignores a module_id sent along with it, and gets the
    // 'external' manufacturer when none is given.
    const first = await post({
      name: 'UMC404HD',
      external: true,
      module_id: fixture.module.id,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      external: true,
      live: false,
      manufacturer: 'external',
      module_name: 'UMC404HD',
      instance: 1,
    });

    // The same gear again — matched by name, case-insensitively — is #2.
    const second = await post({ name: 'umc404hd', external: true });
    expect(second.status).toBe(201);
    expect(second.body.instance).toBe(2);
  });

  it('declares and removes connection points on off-rack gear with validation', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie, output } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = async () =>
      (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    const maths = (await detail()).modules.find((m) => m.module_name === 'Maths');
    const gear = (
      await request(app)
        .post(`/api/patches/${patch.id}/modules`)
        .set('Cookie', aliceCookie)
        .send({ name: 'UMC404HD', external: true })
    ).body;
    const post = (pmId, body) =>
      request(app)
        .post(`/api/patches/${patch.id}/modules/${pmId}/ports`)
        .set('Cookie', aliceCookie)
        .send(body);

    // A live module's connection points come from its analysis, not the patch.
    const live = await post(maths.id, { name: 'IN 9' });
    expect(live.status).toBe(400);
    expect(live.body.error).toMatch(/analyzed components/);

    expect((await post(99999, { name: 'IN 1' })).status).toBe(404);
    expect((await post(gear.id, { name: '   ' })).status).toBe(400);
    const badType = await post(gear.id, { name: 'IN 1', type: 'knob' });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toMatch(/type must be one of/);
    const badKind = await post(gear.id, { name: 'IN 1', port_kind: 'firewire' });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toMatch(/port_kind must be one of/);

    // Spelling variants of the connector normalize to the stored kind.
    const midi = await post(gear.id, {
      name: 'MIDI OUT',
      type: 'output_jack',
      port_kind: 'Midi Din',
    });
    expect(midi.status).toBe(201);
    expect(midi.body.port_kind).toBe('midi_din');

    const port = (await post(gear.id, { name: 'IN 1', description: ' left channel ' })).body;
    expect(port).toMatchObject({
      type: 'input_jack',
      description: 'left channel',
      declared: true,
      patch_module_id: gear.id,
    });
    expect((await post(gear.id, { name: 'in 1' })).status).toBe(409);

    // Deleting a port takes the cable patched into it along.
    await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: output.id,
        to_patch_module_id: gear.id,
        to_component_id: port.id,
      });
    expect((await detail()).cables).toHaveLength(1);
    const remove = (pmId, portId) =>
      request(app)
        .delete(`/api/patches/${patch.id}/modules/${pmId}/ports/${portId}`)
        .set('Cookie', aliceCookie);
    expect((await remove(99999, port.id)).status).toBe(404);
    expect((await remove(gear.id, 'abc')).status).toBe(404);
    expect((await remove(gear.id, port.id)).status).toBe(200);
    const after = await detail();
    expect(after.cables).toEqual([]);
    const ports = after.modules.find((m) => m.id === gear.id).components.map((c) => c.name);
    expect(ports).toEqual(['MIDI OUT']);
    expect((await remove(gear.id, port.id)).status).toBe(404);
  });

  it('renames groups and validates group edits', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const patch = (await createPatch(fixture)).body;
    const post = (body) =>
      request(app).post(`/api/patches/${patch.id}/groups`).set('Cookie', aliceCookie).send(body);
    const put = (groupId, body) =>
      request(app)
        .put(`/api/patches/${patch.id}/groups/${groupId}`)
        .set('Cookie', aliceCookie)
        .send(body);

    expect((await post({ name: '   ' })).status).toBe(400);
    const made = await post({ name: 'Rhythm', description: ' the drums ', position: 5 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Rhythm', description: 'the drums', position: 5 });

    expect((await put(99999, { name: 'x' })).status).toBe(404);
    expect((await put(made.body.id, { name: '   ' })).status).toBe(400);
    const renamed = await put(made.body.id, { name: ' Groove ', description: '' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Groove', description: null, position: 5 });

    // An empty update changes nothing and answers with the group as it is.
    const noop = await put(made.body.id, {});
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ name: 'Groove', position: 5 });

    // An instance can only be filed under a group of its own patch.
    const other = (await createPatch(fixture, { name: 'Other' })).body;
    const detail = await request(app)
      .get(`/api/patches/${other.id}`)
      .set('Cookie', aliceCookie);
    const pm = detail.body.modules[0];
    const foreign = await request(app)
      .put(`/api/patches/${other.id}/modules/${pm.id}`)
      .set('Cookie', aliceCookie)
      .send({ group_id: made.body.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/group of this patch/);

    expect(
      (
        await request(app)
          .delete(`/api/patches/${patch.id}/groups/99999`)
          .set('Cookie', aliceCookie)
      ).status
    ).toBe(404);
  });
});

// A patch is referred to by its name, so one account holds each name once
// (migration 035). Deleting a patch gives its name back: only live patches
// are in anybody's way.
describe('patch names', () => {
  it('refuses a second patch of the same name, and lets a deleted one go', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const first = await createPatch(fixture);
    expect(first.status).toBe(201);

    const again = await createPatch(fixture);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("you already have a patch called 'Krell'");
    // A name is only taken while the patch holding it is there.
    await request(app).delete(`/api/patches/${first.body.id}`).set('Cookie', aliceCookie);
    expect((await createPatch(fixture)).status).toBe(201);
  });

  // Per account, not globally: two people may each call a patch 'Krell'.
  it('is one name per user, not one name for everybody', async () => {
    const fixture = await withPatchFixture();
    const { db, admin } = fixture;
    expect((await createPatch(fixture)).status).toBe(201);
    await expect(
      db.query('INSERT INTO patches (user_id, rack_name, name) VALUES ($1, $2, $3)', [
        admin.id,
        'admin rack',
        'Krell',
      ])
    ).resolves.toBeDefined();
  });

  it('refuses a rename onto another patch, and allows one onto itself', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const krell = (await createPatch(fixture)).body;
    const drone = (await createPatch(fixture, { name: 'Drone' })).body;

    const clash = await request(app)
      .put(`/api/patches/${drone.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Krell' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toContain("you already have a patch called 'Krell'");

    // Its own name is not a clash: this is how a description is edited
    // without renaming anything.
    const itself = await request(app)
      .put(`/api/patches/${krell.id}`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Krell', description: 'the good one' });
    expect(itself.status).toBe(200);
    expect(itself.body).toMatchObject({ name: 'Krell', description: 'the good one' });
  });

  it('numbers the copies of a patch and refuses a copy name that is taken', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie } = fixture;
    const patch = (await createPatch(fixture)).body;
    const clone = () =>
      request(app).post(`/api/patches/${patch.id}/clone`).set('Cookie', aliceCookie).send({});
    expect((await clone()).body.name).toBe('Krell (copy)');
    expect((await clone()).body.name).toBe('Krell (copy) 2');

    const named = await request(app)
      .post(`/api/patches/${patch.id}/clone`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Krell (copy)' });
    expect(named.status).toBe(409);
    expect(named.body.error).toContain("you already have a patch called 'Krell (copy)'");
  });
  // The check above and the unique index are the same rule applied twice:
  // two requests can both find a name free and both go on to take it, and the
  // index catches the loser. isNameConflict is what tells that apart from
  // every other write failure, so the loser gets the same 409 rather than a
  // 500. pg-mem cannot race, so the recognizer is asserted directly.
  it('recognizes the unique index catching a name race, and nothing else', () => {
    const conflict = (extra) =>
      isNameConflict({ name: 'SequelizeUniqueConstraintError', ...extra });

    // Postgres names the constraint on the error's `parent` (or `original`).
    expect(conflict({ parent: { constraint: 'patches_user_name_uniq' } })).toBe(true);
    expect(conflict({ original: { constraint: 'patches_user_name_uniq' } })).toBe(true);
    // A DIFFERENT unique index is a different bug and must not be swallowed
    // as a name clash.
    expect(conflict({ parent: { constraint: 'rack_rows_rack_position_uniq' } })).toBe(false);
    // Some drivers report only the offending paths.
    expect(conflict({ errors: [{ path: 'name' }] })).toBe(true);
    expect(conflict({ errors: [{ path: 'patches_user_name_uniq' }] })).toBe(true);
    expect(conflict({ errors: [{ path: 'hp' }] })).toBe(false);
    expect(conflict({})).toBe(false);
    // Anything that is not a uniqueness failure at all.
    expect(isNameConflict(new Error('connection reset'))).toBe(false);
    expect(isNameConflict(null)).toBe(false);
  });

  it('hands out the next free number for a name the app made up', async () => {
    const fixture = await withPatchFixture();
    const { db, alice } = fixture;
    // Nothing taken: the name asked for is the name given.
    expect(await freePatchName(db, alice.id, 'Krell')).toBe('Krell');
    await createPatch(fixture);
    expect(await freePatchName(db, alice.id, 'Krell')).toBe('Krell 2');
    await createPatch(fixture, { name: 'Krell 2' });
    await createPatch(fixture, { name: 'Krell 3' });
    expect(await freePatchName(db, alice.id, 'Krell')).toBe('Krell 4');
    // Another user's 'Krell' is not in the way of this one's.
    expect(await freePatchName(db, fixture.admin.id, 'Krell')).toBe('Krell');
  });
});

// Building a patch faster: copying one whole, turning a cable around, and
// the cables the user's other patches suggest for this one.
describe('patch shortcuts', () => {
  it('clones a patch with its cables, settings, buses, labels and links', async () => {
    const fixture = await withPatchFixture();
    const { app, aliceCookie, input, output, knob } = fixture;
    const patch = (await createPatch(fixture)).body;
    const detail = async (id) =>
      (await request(app).get(`/api/patches/${id}`).set('Cookie', aliceCookie)).body;

    const before = await detail(patch.id);
    const maths = before.modules.find((m) => m.module_name === 'Maths');
    const post = (path, body) =>
      request(app).post(`/api/patches/${patch.id}${path}`).set('Cookie', aliceCookie).send(body);

    await post('/cables', {
      from_patch_module_id: maths.id,
      from_component_id: output.id,
      to_patch_module_id: maths.id,
      to_component_id: input.id,
      note: 'self-patched',
    });
    await request(app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', aliceCookie)
      .send({ patch_module_id: maths.id, component_id: knob.id, value: '7' });
    const group = (await post('/groups', { name: 'Rhythm' })).body;
    await request(app)
      .put(`/api/patches/${patch.id}/modules/${maths.id}`)
      .set('Cookie', aliceCookie)
      .send({ label: 'the voice', group_id: group.id });
    // Off-rack gear with a connection point declared inside the patch, and a
    // cable into it — its component id must be rewritten by the clone.
    const gear = (await post('/modules', { module_name: 'UMC404HD', external: true })).body;
    const port = (await post(`/modules/${gear.id}/ports`, { name: 'IN 1' })).body;
    await post('/cables', {
      from_patch_module_id: maths.id,
      from_component_id: output.id,
      to_patch_module_id: gear.id,
      to_component_id: port.id,
    });

    const cloned = await request(app)
      .post(`/api/patches/${patch.id}/clone`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Krell variation' });
    expect(cloned.status).toBe(201);
    expect(cloned.body.name).toBe('Krell variation');

    const copy = await detail(cloned.body.id);
    expect(copy.id).not.toBe(patch.id);
    expect(copy.rack_name).toBe(before.rack_name);
    expect(copy.modules).toHaveLength(before.modules.length + 1);
    const copiedMaths = copy.modules.find((m) => m.module_name === 'Maths');
    expect(copiedMaths.label).toBe('the voice');
    expect(copy.groups.map((g) => g.name)).toEqual(['Rhythm']);
    expect(copiedMaths.group_id).toBe(copy.groups[0].id);
    expect(copy.settings).toHaveLength(1);
    expect(copy.settings[0]).toMatchObject({ component_name: 'Rise', value: '7' });

    // Every cable points at the COPY's instances, not the original's.
    expect(copy.cables).toHaveLength(2);
    const ids = new Set(copy.modules.map((m) => m.id));
    for (const cable of copy.cables) {
      expect(ids.has(cable.from_patch_module_id)).toBe(true);
      expect(ids.has(cable.to_patch_module_id)).toBe(true);
    }
    expect(copy.cables[0].note).toBe('self-patched');
    // The declared connection point was copied, and the cable follows it.
    const copiedGear = copy.modules.find((m) => m.module_name === 'UMC404HD');
    expect(copiedGear.components).toHaveLength(1);
    expect(copiedGear.components[0].id).not.toBe(port.id);
    const toGear = copy.cables.find((c) => c.to_patch_module_id === copiedGear.id);
    expect(toGear.to_component_id).toBe(copiedGear.components[0].id);
    expect(toGear.to_component_name).toBe('IN 1');

    // The original is untouched, and the copy is independent of it.
    const original = await detail(patch.id);
    expect(original.cables).toHaveLength(2);
    await request(app)
      .delete(`/api/patches/${cloned.body.id}/cables/${copy.cables[0].id}`)
      .set('Cookie', aliceCookie);
    expect((await detail(patch.id)).cables).toHaveLength(2);

    // Default name, and no reaching into someone else's patch.
    const unnamed = await request(app)
      .post(`/api/patches/${patch.id}/clone`)
      .set('Cookie', aliceCookie)
      .send({});
    expect(unnamed.body.name).toBe('Krell (copy)');
    const stranger = await request(app)
      .post(`/api/patches/${patch.id}/clone`)
      .set('Cookie', fixture.adminCookie)
      .send({});
    expect(stranger.status).toBe(404);
  });

  it('turns a cable around when both jacks can take the other role', async () => {
    const fixture = await withPatchFixture();
    const { app, db, aliceCookie, alice, output } = fixture;
    const mult = await insertModule(db, alice.id, { manufacturer: 'Doepfer', name: 'A-180-2' });
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name, group_label) VALUES
         ($1, 'bidirectional_jack', 'M1', '1'), ($1, 'bidirectional_jack', 'M2', '1')
       RETURNING *`,
      [mult.id]
    );
    const patch = (await createPatch(fixture)).body;
    const detail = async () =>
      (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)).body;
    const before = await detail();
    const multPm = before.modules.find((m) => m.module_name === 'A-180-2');
    const mathsPm = before.modules.find((m) => m.module_name === 'Maths');

    // Entered backwards: the mult jack sending into Maths' input is right,
    // but the user typed it the other way round first.
    const cable = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: multPm.id,
        from_component_id: jacks[0].id,
        to_patch_module_id: multPm.id,
        to_component_id: jacks[1].id,
        note: 'keep me',
      });
    expect(cable.status).toBe(400); // same mult group — nothing to reverse

    const real = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: mathsPm.id,
        from_component_id: output.id,
        to_patch_module_id: multPm.id,
        to_component_id: jacks[0].id,
        note: 'keep me',
      });
    expect(real.status).toBe(201);
    // EOR is an output: it cannot become a destination.
    const refused = await request(app)
      .post(`/api/patches/${patch.id}/cables/${real.body.id}/reverse`)
      .set('Cookie', aliceCookie);
    expect(refused.status).toBe(400);
    expect((await detail()).cables).toHaveLength(1);

    // Between two mult jacks of different groups, reversing is legal — as
    // long as neither group already takes its input elsewhere (group 1 does:
    // EOR is patched into M1).
    const { rows: more } = await db.query(
      `INSERT INTO module_components (module_id, type, name, group_label) VALUES
         ($1, 'bidirectional_jack', 'M3', '2'), ($1, 'bidirectional_jack', 'M4', '3')
       RETURNING *`,
      [mult.id]
    );
    const [m3, m4] = more;
    const blocked = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: multPm.id,
        from_component_id: jacks[1].id,
        to_patch_module_id: multPm.id,
        to_component_id: m3.id,
      });
    expect(blocked.status).toBe(201);
    // M2 carries a copy out of group 1, so turning THAT cable around would
    // make M2 an input its group already has at M1.
    const refusedGroup = await request(app)
      .post(`/api/patches/${patch.id}/cables/${blocked.body.id}/reverse`)
      .set('Cookie', aliceCookie);
    expect(refusedGroup.status).toBe(409);
    await request(app)
      .delete(`/api/patches/${patch.id}/cables/${blocked.body.id}`)
      .set('Cookie', aliceCookie);

    const both = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: multPm.id,
        from_component_id: m3.id,
        to_patch_module_id: multPm.id,
        to_component_id: m4.id,
        note: 'turn me around',
      });
    expect(both.status).toBe(201);
    const reversed = await request(app)
      .post(`/api/patches/${patch.id}/cables/${both.body.id}/reverse`)
      .set('Cookie', aliceCookie);
    expect(reversed.status).toBe(201);
    expect(reversed.body).toMatchObject({
      from_component_name: 'M4',
      to_component_name: 'M3',
      note: 'turn me around',
    });
    const after = await detail();
    expect(after.cables).toHaveLength(2);
    expect(after.cables.some((c) => c.id === both.body.id)).toBe(false);
  });

  it('suggests cables from the patches the user has already built', async () => {
    const fixture = await withPatchFixture();
    const { app, db, aliceCookie, alice, input, output } = fixture;
    const vca = await insertModule(db, alice.id, { manufacturer: 'Intellijel', name: 'Dual VCA' });
    const { rows: vcaJacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'input_jack', 'IN 1'), ($1, 'output_jack', 'OUT 1') RETURNING *`,
      [vca.id]
    );
    const inJack = vcaJacks.find((j) => j.name === 'IN 1');

    // Two earlier patches with the same habit: Maths EOR → Dual VCA IN 1.
    const older = [];
    for (const name of ['First', 'Second']) {
      const p = (await createPatch(fixture, { name })).body;
      const body = (
        await request(app).get(`/api/patches/${p.id}`).set('Cookie', aliceCookie)
      ).body;
      const maths = body.modules.find((m) => m.module_name === 'Maths');
      const dual = body.modules.find((m) => m.module_name === 'Dual VCA');
      const res = await request(app)
        .post(`/api/patches/${p.id}/cables`)
        .set('Cookie', aliceCookie)
        .send({
          from_patch_module_id: maths.id,
          from_component_id: output.id,
          to_patch_module_id: dual.id,
          to_component_id: inJack.id,
        });
      expect(res.status).toBe(201);
      older.push(p);
    }
    expect(older).toHaveLength(2);

    const patch = (await createPatch(fixture, { name: 'Third' })).body;
    const suggest = async () =>
      (await request(app).get(`/api/patches/${patch.id}/suggestions`).set('Cookie', aliceCookie))
        .body;

    const first = await suggest();
    expect(first.suggestions).toHaveLength(1);
    expect(first.suggestions[0]).toMatchObject({
      from_component_name: 'EOR',
      to_component_name: 'IN 1',
      patches: 2,
    });

    // Plug it and it stops being a suggestion.
    const plugged = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: first.suggestions[0].from_patch_module_id,
        from_component_id: first.suggestions[0].from_component_id,
        to_patch_module_id: first.suggestions[0].to_patch_module_id,
        to_component_id: first.suggestions[0].to_component_id,
      });
    expect(plugged.status).toBe(201);
    expect((await suggest()).suggestions).toEqual([]);

    // A patch with nothing to learn from suggests nothing, and another
    // user's patches never leak in.
    const { rows: patches } = await db.query('SELECT id FROM patches ORDER BY id');
    expect(patches.length).toBeGreaterThan(2);
    const strangers = await request(app)
      .get(`/api/patches/${patch.id}/suggestions`)
      .set('Cookie', fixture.adminCookie);
    expect(strangers.status).toBe(404);
    expect(input).toBeTruthy();
  });
});

describe('system patches', () => {
  // Alice's studio: a Maths in the left case, a Plaits in the right case,
  // both racks in one system. Each module has one input and one output jack.
  async function withSystemFixture() {
    const fixture = await createTestApp();
    const { db, app, aliceCookie } = fixture;
    const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
    fixture.alice = users.find((u) => u.username === 'alice');

    const jacks = async (moduleId) => {
      const { rows } = await db.query(
        `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'input_jack', 'In'), ($1, 'output_jack', 'Out') RETURNING *`,
        [moduleId]
      );
      return {
        input: rows.find((c) => c.type === 'input_jack'),
        output: rows.find((c) => c.type === 'output_jack'),
      };
    };
    fixture.maths = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Make Noise',
      name: 'Maths',
      rack: 'left case',
      hp: 20,
    });
    fixture.mathsJacks = await jacks(fixture.maths.id);
    fixture.plaits = await insertModule(db, fixture.alice.id, {
      manufacturer: 'Mutable',
      name: 'Plaits',
      rack: 'right case',
      hp: 12,
    });
    fixture.plaitsJacks = await jacks(fixture.plaits.id);

    const racks = (await request(app).get('/api/racks').set('Cookie', aliceCookie)).body;
    fixture.leftRack = racks.find((r) => r.name === 'left case');
    fixture.rightRack = racks.find((r) => r.name === 'right case');
    fixture.system = (
      await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'studio' })
    ).body;
    for (const rack of [fixture.leftRack, fixture.rightRack]) {
      await request(app)
        .put(`/api/racks/${rack.id}/system`)
        .set('Cookie', aliceCookie)
        .send({ system_id: fixture.system.id });
    }
    return fixture;
  }

  it('snapshots every rack in the system, remembering which rack each copy came from', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system } = fixture;
    const created = await request(app)
      .post('/api/patches')
      .set('Cookie', aliceCookie)
      .send({ system_id: system.id, name: 'Whole studio' });
    expect(created.status).toBe(201);
    expect(created.body.module_count).toBe(2);
    expect(created.body.system_id).toBe(system.id);
    expect(created.body.system_name).toBe('studio');
    // A system patch belongs to no single rack.
    expect(created.body.rack_id).toBe(null);

    const detail = await request(app)
      .get(`/api/patches/${created.body.id}`)
      .set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    expect(
      detail.body.modules.map((m) => [m.module_name, m.rack_name])
    ).toEqual([
      ['Maths', 'left case'],
      ['Plaits', 'right case'],
    ]);
    expect(detail.body.modules.every((m) => m.live)).toBe(true);
  });

  it('runs a cable from a jack in one rack to a jack in another', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system } = fixture;
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Cross-case' })
    ).body;
    const detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;
    const maths = detail.modules.find((m) => m.module_name === 'Maths');
    const plaits = detail.modules.find((m) => m.module_name === 'Plaits');

    // Maths (left case) out → Plaits (right case) in: the whole point of a
    // system, and something a single-rack patch could not express.
    const cable = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: maths.id,
        from_component_id: fixture.mathsJacks.output.id,
        to_patch_module_id: plaits.id,
        to_component_id: fixture.plaitsJacks.input.id,
      });
    expect(cable.status).toBe(201);

    const after = (await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie))
      .body;
    expect(after.cables).toHaveLength(1);
    expect(after.cables[0]).toMatchObject({
      from_component_name: 'Out',
      to_component_name: 'In',
    });
    // The cable-legality rules still apply across racks: that input is taken.
    const twice = await request(app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: plaits.id,
        from_component_id: fixture.plaitsJacks.output.id,
        to_patch_module_id: plaits.id,
        to_component_id: fixture.plaitsJacks.input.id,
      });
    expect(twice.status).toBe(409);
  });

  it('lays out a system patch rack by rack', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system } = fixture;
    // Each case gets one physical row holding its module.
    for (const [rack, module] of [
      [fixture.leftRack, fixture.maths],
      [fixture.rightRack, fixture.plaits],
    ]) {
      await request(app)
        .put(`/api/racks/${rack.id}/layout`)
        .set('Cookie', aliceCookie)
        .send({ rows: [{ unit: 3, hp: 84, modules: [{ module_id: module.id }] }] });
    }
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Laid out' })
    ).body;
    const detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;

    expect(detail.rack_layout).toHaveLength(2);
    expect(detail.rack_layout.map((row) => row.rack_name)).toEqual(['left case', 'right case']);
    // Each row places the instance from ITS OWN rack, not just the next one
    // that happens to be the same module.
    const instanceOf = (name) => detail.modules.find((m) => m.module_name === name).id;
    expect(detail.rack_layout[0].modules).toEqual([instanceOf('Maths')]);
    expect(detail.rack_layout[1].modules).toEqual([instanceOf('Plaits')]);
  });

  // The floor plan is where a person arranges their studio, so it is what the
  // picture of the studio follows: rack by rack as they STAND, not in the
  // order some earlier save happened to send them in.
  it('reads the racks of a system in the order they stand on its floor plan', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system, leftRack, rightRack } = fixture;
    for (const [rack, module] of [
      [fixture.leftRack, fixture.maths],
      [fixture.rightRack, fixture.plaits],
    ]) {
      await request(app)
        .put(`/api/racks/${rack.id}/layout`)
        .set('Cookie', aliceCookie)
        .send({ rows: [{ unit: 3, hp: 84, modules: [{ module_id: module.id }] }] });
    }
    // The right case is moved to the near end of the floor, the left case
    // behind it — so the studio now reads right case first.
    const moved = await request(app)
      .put(`/api/systems/${system.id}/layout`)
      .set('Cookie', aliceCookie)
      .send({
        racks: [
          { rack_id: leftRack.id, x: 0, y: 6 },
          { rack_id: rightRack.id, x: 0, y: 0 },
        ],
      });
    expect(moved.status).toBe(200);

    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'As it stands' })
    ).body;
    const detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.rack_layout.map((row) => row.rack_name)).toEqual(['right case', 'left case']);
  });

  it('keeps the arrangement it was built with when the rack is rebuilt', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, leftRack, maths, plaits, db } = fixture;
    // Both modules stand in the left case, Maths first.
    await mapModule(db, fixture.alice.id, plaits.id, { rack: 'left case' });
    const organize = (modules) =>
      request(app)
        .put(`/api/racks/${leftRack.id}/layout`)
        .set('Cookie', aliceCookie)
        .send({ rows: [{ unit: 3, hp: 84, modules }] });
    await organize([{ module_id: maths.id }, { module_id: plaits.id }]);

    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: leftRack.id, name: 'As it stood' })
    ).body;
    const detail = async (id = patch.id) =>
      (await request(app).get(`/api/patches/${id}`).set('Cookie', aliceCookie)).body;
    const order = (body) =>
      body.rack_layout[0].modules.map(
        (instanceId) => body.modules.find((m) => m.id === instanceId).module_name
      );
    expect(order(await detail())).toEqual(['Maths', 'Plaits']);

    // The case is rebuilt with the two modules the other way round. The
    // patch is a picture of the studio as it was, so it does not move.
    await organize([{ module_id: plaits.id }, { module_id: maths.id }]);
    expect(order(await detail())).toEqual(['Maths', 'Plaits']);
    // A patch made now sees the new arrangement.
    const after = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: leftRack.id, name: 'As it stands' })
    ).body;
    expect(order(await detail(after.id))).toEqual(['Plaits', 'Maths']);

    // A clone copies the patch, not the studio: it inherits the old picture.
    const clone = (
      await request(app)
        .post(`/api/patches/${patch.id}/clone`)
        .set('Cookie', aliceCookie)
        .send({})
    ).body;
    expect(order(await detail(clone.id))).toEqual(['Maths', 'Plaits']);

    // Told to catch up, the old patch takes a fresh copy — and keeps its
    // instances, so the cables in it still point at something.
    const resync = await request(app)
      .post(`/api/patches/${patch.id}/rack-layout/resync`)
      .set('Cookie', aliceCookie)
      .send({});
    expect(resync.status).toBe(200);
    expect(order(await detail())).toEqual(['Plaits', 'Maths']);
    expect((await detail()).modules).toHaveLength(2);
  });

  it('lets nobody but the owner resync a patch layout', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, adminCookie, leftRack } = fixture;
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: leftRack.id, name: 'Mine' })
    ).body;
    expect(
      (
        await request(app)
          .post(`/api/patches/${patch.id}/rack-layout/resync`)
          .set('Cookie', adminCookie)
          .send({})
      ).status
    ).toBe(404);
  });

  it('keeps the two copies of one module in the racks they stand in', async () => {
    const fixture = await withSystemFixture();
    const { app, db, aliceCookie, system } = fixture;
    // The same Maths in both cases, each placed in its own rack's row.
    await mapModule(db, fixture.alice.id, fixture.maths.id, { rack: 'right case' });
    for (const rack of [fixture.leftRack, fixture.rightRack]) {
      await request(app)
        .put(`/api/racks/${rack.id}/layout`)
        .set('Cookie', aliceCookie)
        .send({ rows: [{ unit: 3, hp: 84, modules: [{ module_id: fixture.maths.id }] }] });
    }
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Two Mathses' })
    ).body;
    const detail = (
      await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie)
    ).body;

    const mathses = detail.modules.filter((m) => m.module_name === 'Maths');
    // Numbering runs across the whole system, and each copy names its rack.
    expect(mathses.map((m) => [m.instance, m.rack_name]).sort()).toEqual([
      [1, 'left case'],
      [2, 'right case'],
    ]);
    // Each rack's row draws the copy that actually stands in it.
    const rackOf = (id) => mathses.find((m) => m.id === id).rack_name;
    expect(detail.rack_layout.map((row) => [row.rack_name, rackOf(row.modules[0])])).toEqual([
      ['left case', 'left case'],
      ['right case', 'right case'],
    ]);
  });

  it('refuses a system that is empty, or that belongs to somebody else', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, adminCookie, system } = fixture;
    const bare = (
      await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'bare' })
    ).body;
    const empty = await request(app)
      .post('/api/patches')
      .set('Cookie', aliceCookie)
      .send({ system_id: bare.id, name: 'nothing here' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/no racks/);

    const foreign = await request(app)
      .post('/api/patches')
      .set('Cookie', adminCookie)
      .send({ system_id: system.id, name: 'steal' });
    expect(foreign.status).toBe(404);
  });

  it('keeps rendering a system patch after the system is deleted', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system } = fixture;
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Outlives it' })
    ).body;
    expect(
      (await request(app).delete(`/api/systems/${system.id}`).set('Cookie', aliceCookie)).status
    ).toBe(200);

    const detail = await request(app).get(`/api/patches/${patch.id}`).set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    // The name is snapshotted, so the patch still says what it was built from.
    expect(detail.body.system_name).toBe('studio');
    expect(detail.body.modules.map((m) => m.rack_name)).toEqual(['left case', 'right case']);
  });

  it('carries the system and per-instance racks into a clone', async () => {
    const fixture = await withSystemFixture();
    const { app, aliceCookie, system } = fixture;
    const patch = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ system_id: system.id, name: 'Original' })
    ).body;
    const copy = (
      await request(app).post(`/api/patches/${patch.id}/clone`).set('Cookie', aliceCookie).send({})
    ).body;
    const detail = (
      await request(app).get(`/api/patches/${copy.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.system_id).toBe(system.id);
    expect(detail.system_name).toBe('studio');
    expect(detail.modules.map((m) => m.rack_name)).toEqual(['left case', 'right case']);
  });
});
