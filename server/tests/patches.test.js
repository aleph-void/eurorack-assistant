import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, mapModule, fakeBackend } from './helpers.js';
import {
  analyzeManualForModule,
  normalizeComponentValues,
} from '../src/services/manualAnalyzer.js';
import { resolveNormalledSignals } from '../src/services/patchSignals.js';
import { buildPatchTopology } from '../src/services/patchTopology.js';

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

    // Nothing patched: both normals are active; In 2's chained signal is the
    // internal source feeding In 1.
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

  it('keeps showing cables by name after the module is deleted outright', async () => {
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

    // Remove the module from every rack — the shared record is hard-deleted.
    const res = await request(app)
      .delete(`/api/modules/${fixture.module.id}`)
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(await db.models.Module.findByPk(fixture.module.id)).toBeNull();

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
});
