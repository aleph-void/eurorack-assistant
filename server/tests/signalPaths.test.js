import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, fakeBackend } from './helpers.js';
import { analyzeManualForModule } from '../src/services/manualAnalyzer.js';
import { buildPatchTopology } from '../src/services/patchTopology.js';
import { buildSignalFlow, MAX_FLOW_NODES } from '../src/services/patchFlow.js';

// Fixture: alice's rack, ready to have modules dropped into it.
async function fixture() {
  const f = await createTestApp();
  const { rows: users } = await f.db.query('SELECT id, username FROM users ORDER BY id');
  f.alice = users.find((u) => u.username === 'alice');
  return f;
}

// A module with the given components, keyed by name for the tests.
async function withComponents(f, { manufacturer, name, components, quantity = 1 }) {
  const module = await insertModule(f.db, f.alice.id, { manufacturer, name, quantity });
  const created = {};
  for (const c of components) {
    const { rows } = await f.db.query(
      `INSERT INTO module_components (module_id, type, name, group_label, port_kind)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [module.id, c.type, c.name, c.group ?? null, c.port_kind ?? null]
    );
    created[c.name] = rows[0];
  }
  return { module, components: created };
}

async function createPatch(f, name = 'Test patch') {
  // The rack is created lazily with the first module.
  const { rows: racks } = await f.db.query('SELECT id FROM racks WHERE user_id = $1', [f.alice.id]);
  const res = await request(f.app)
    .post('/api/patches')
    .set('Cookie', f.aliceCookie)
    .send({ rack_id: racks[0].id, name });
  expect(res.status).toBe(201);
  return res.body;
}

const detail = async (f, patchId) => {
  const res = await request(f.app).get(`/api/patches/${patchId}`).set('Cookie', f.aliceCookie);
  expect(res.status).toBe(200);
  return res.body;
};

const instanceOf = (patch, moduleName, n = 1) =>
  patch.modules.filter((m) => m.module_name === moduleName)[n - 1];

const jack = (pm, name) => pm.components.find((c) => c.name === name);

// Walk the flow trees into a flat list of "<jack name>" rows.
function flatFlow(patch) {
  const rows = [];
  const walk = (node) => {
    rows.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const tree of patch.flow) walk(tree);
  return rows;
}

describe('conditional signal paths', () => {
  // Intellijel Atlantix: the PWM SOURCE switch decides WHICH signal is
  // normalled to PWM IN. Both defaults are real, but only one at a time —
  // the old model showed them as two signals merging into the input.
  async function atlantix(f) {
    const { module, components } = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Atlantix',
      components: [
        { type: 'input_jack', name: 'PWM IN' },
        { type: 'output_jack', name: 'SINE B' },
        { type: 'output_jack', name: 'ENV OUT' },
        { type: 'switch', name: 'PWM SOURCE' },
      ],
    });
    await f.db.query(
      `INSERT INTO component_values (component_id, type, value)
       VALUES ($1, 'enum', 'left'), ($1, 'enum', 'right')`,
      [components['PWM SOURCE'].id]
    );
    for (const [source, value] of [
      ['SINE B', 'left'],
      ['ENV OUT', 'right'],
    ]) {
      const res = await request(f.app)
        .post(`/api/modules/${module.id}/normalizations`)
        .set('Cookie', f.aliceCookie)
        .send({
          target_component_id: components['PWM IN'].id,
          source_component_id: components[source].id,
          condition_component_id: components['PWM SOURCE'].id,
          condition_value: value,
          alt_group: 'pwm source',
        });
      expect(res.status).toBe(201);
    }
    return { module, components };
  }

  it('records two switch-selected defaults on one input instead of rejecting the second', async () => {
    const f = await fixture();
    const { module, components } = await atlantix(f);
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.normalizations).toHaveLength(2);
    expect(res.body.normalizations[0]).toMatchObject({
      condition_component_id: components['PWM SOURCE'].id,
      condition_value: 'left',
      alt_group: 'pwm source',
    });

    // The same default in the same position is still a duplicate.
    const dupe = await request(f.app)
      .post(`/api/modules/${module.id}/normalizations`)
      .set('Cookie', f.aliceCookie)
      .send({
        target_component_id: components['PWM IN'].id,
        source_component_id: components['SINE B'].id,
        condition_component_id: components['PWM SOURCE'].id,
        condition_value: 'left',
      });
    expect(dupe.status).toBe(409);
  });

  it('treats alternatives as a selection, not a merge, until the switch is dialed in', async () => {
    const f = await fixture();
    await atlantix(f);
    // The flow only traces modules the patch uses, so the Atlantix is cabled
    // into something — its internal defaults are what the test is about.
    await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Mixup',
      components: [{ type: 'input_jack', name: 'IN 1' }],
    });
    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    const atlx = instanceOf(body, 'Atlantix');
    const mixup = instanceOf(body, 'Mixup');
    const patched = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: atlx.id,
        from_component_id: jack(atlx, 'SINE B').id,
        to_patch_module_id: mixup.id,
        to_component_id: jack(mixup, 'IN 1').id,
      });
    expect(patched.status).toBe(201);
    body = await detail(f, patch.id);

    // Both defaults are possible; neither is claimed to be certain, and the
    // input is fed by a selection rather than by two signals summing.
    expect(body.normalizations).toHaveLength(2);
    expect(body.normalizations.every((n) => n.active && n.exclusive)).toBe(true);
    expect(body.normalizations.map((n) => n.condition.state)).toEqual(['unset', 'unset']);
    const pwmIn = flatFlow(body).find((n) => n.name === 'PWM IN');
    expect(pwmIn).toMatchObject({ switched_merge: true, merge: false, conditional: true });

    // Dial the switch in and only that position's default survives.
    const pm = instanceOf(body, 'Atlantix');
    const res = await request(f.app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', f.aliceCookie)
      .send({
        patch_module_id: pm.id,
        component_id: jack(pm, 'PWM SOURCE').id,
        value: 'right',
      });
    expect(res.status).toBe(201);

    body = await detail(f, patch.id);
    expect(body.normalizations).toHaveLength(1);
    expect(body.normalizations[0]).toMatchObject({
      source_component_name: 'ENV OUT',
      exclusive: false,
      active: true,
    });
    expect(body.normalizations[0].condition.state).toBe('selected');
    const after = flatFlow(body).find((n) => n.name === 'PWM IN');
    expect(after.merge).toBe(false);
    expect(after.switched_merge).toBe(false);
  });

  // Erogenous Tones Levit8: with the MIX switch down, OUT 4 passes IN 4
  // through; with it up, OUT 4 is a mix of channels 1-4.
  it('switches a module between a pass-through and a channel mix', async () => {
    const f = await fixture();
    const { module, components } = await withComponents(f, {
      manufacturer: 'Erogenous Tones',
      name: 'Levit8',
      components: [
        { type: 'input_jack', name: 'IN 1' },
        { type: 'input_jack', name: 'IN 4' },
        { type: 'output_jack', name: 'OUT 4' },
        { type: 'switch', name: 'MIX 4' },
      ],
    });
    const post = (body) =>
      request(f.app)
        .post(`/api/modules/${module.id}/routes`)
        .set('Cookie', f.aliceCookie)
        .send(body);
    // IN 4 → OUT 4 always; IN 1 → OUT 4 only with the mix engaged.
    expect((await post({ input_component_id: components['IN 4'].id, output_component_id: components['OUT 4'].id })).status).toBe(201);
    const mixed = await post({
      input_component_id: components['IN 1'].id,
      output_component_id: components['OUT 4'].id,
      condition_component_id: components['MIX 4'].id,
      condition_value: 'up',
      alt_group: 'mix 4',
    });
    expect(mixed.status).toBe(201);

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    const pm = instanceOf(body, 'Levit8');
    // Feed both inputs so the paths have signal to carry.
    const { module: source } = await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    await request(f.app)
      .post(`/api/patches/${patch.id}/modules`)
      .set('Cookie', f.aliceCookie)
      .send({ module_id: source.id });
    body = await detail(f, patch.id);
    const osc = instanceOf(body, 'A-110');
    for (const input of ['IN 1', 'IN 4']) {
      const res = await request(f.app)
        .post(`/api/patches/${patch.id}/cables`)
        .set('Cookie', f.aliceCookie)
        .send({
          from_patch_module_id: osc.id,
          from_component_id: jack(osc, 'SAW').id,
          to_patch_module_id: pm.id,
          to_component_id: jack(pm, input).id,
        });
      expect(res.status).toBe(201);
    }

    // Switch not recorded: IN 4 always reaches OUT 4, while IN 1 only does
    // with the mix engaged — so the convergence is a real mix, but the extra
    // channel is flagged as depending on a position the patch has not pinned
    // down.
    body = await detail(f, patch.id);
    let out4 = flatFlow(body).filter((n) => n.name === 'OUT 4');
    expect(out4).toHaveLength(2);
    expect(out4.some((n) => n.merge)).toBe(true);
    const conditional = out4.find((n) => n.conditional);
    expect(conditional.condition).toMatchObject({
      component_name: 'MIX 4',
      value: 'up',
      state: 'unset',
    });

    // With the switch down, the mix path is gone entirely.
    await request(f.app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', f.aliceCookie)
      .send({ patch_module_id: pm.id, component_id: jack(pm, 'MIX 4').id, value: 'down' });
    body = await detail(f, patch.id);
    out4 = flatFlow(body).filter((n) => n.name === 'OUT 4');
    expect(out4).toHaveLength(1);
    expect(out4[0]).toMatchObject({ merge: false, switched_merge: false });

    // With it up, both channels really do sum into OUT 4.
    await request(f.app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', f.aliceCookie)
      .send({ patch_module_id: pm.id, component_id: jack(pm, 'MIX 4').id, value: 'up' });
    body = await detail(f, patch.id);
    expect(flatFlow(body).some((n) => n.name === 'OUT 4' && n.merge)).toBe(true);
  });

  it('extracts conditions and alternatives from the manual', async () => {
    const f = await fixture();
    const module = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlx' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'Switchable normals.',
        components: [
          { type: 'input_jack', name: 'PWM IN' },
          { type: 'output_jack', name: 'SINE B' },
          { type: 'switch', name: 'PWM SOURCE', value_options: ['left', 'right'] },
        ],
        normalizations: [
          {
            target: 'PWM IN',
            source: 'SINE B',
            condition: { control: 'PWM SOURCE', value: 'left' },
            alternative_group: 'pwm source',
          },
        ],
        routes: [],
      }),
    });
    await analyzeManualForModule(f.db, backend, module, '/tmp/x.pdf');
    const { rows } = await f.db.query(
      `SELECT n.condition_value, n.alt_group, c.name AS control
         FROM component_normalizations n
         JOIN module_components c ON c.id = n.condition_component_id
        WHERE n.module_id = $1`,
      [module.id]
    );
    expect(rows).toEqual([
      { condition_value: 'left', alt_group: 'pwm source', control: 'PWM SOURCE' },
    ]);
  });

  it('rejects a condition that names a jack or omits its value', async () => {
    const f = await fixture();
    const { module, components } = await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-138',
      components: [
        { type: 'input_jack', name: 'IN' },
        { type: 'output_jack', name: 'OUT' },
      ],
    });
    const base = {
      input_component_id: components.IN.id,
      output_component_id: components.OUT.id,
    };
    const onJack = await request(f.app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({ ...base, condition_component_id: components.IN.id, condition_value: 'up' });
    expect(onJack.status).toBe(400);
    expect(onJack.body.error).toMatch(/names a control/);

    const noValue = await request(f.app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({ ...base, condition_component_id: components.OUT.id });
    expect(noValue.status).toBe(400);
  });
});

describe('expander panels', () => {
  // Intellijel Atlantix + Atlx: the filter lives on the host, its outputs on
  // the expander, joined by a ribbon cable.
  async function pair(f) {
    const host = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Atlantix',
      components: [{ type: 'input_jack', name: 'VCF IN' }],
    });
    const expander = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Atlx',
      components: [{ type: 'output_jack', name: 'LP' }],
    });
    const link = await request(f.app)
      .post(`/api/modules/${host.module.id}/expanders`)
      .set('Cookie', f.aliceCookie)
      .send({ expander_module_id: expander.module.id });
    expect(link.status).toBe(201);
    return { host, expander };
  }

  it('lets a route on the host end at a jack on the expander', async () => {
    const f = await fixture();
    const { host, expander } = await pair(f);
    const route = await request(f.app)
      .post(`/api/modules/${host.module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({
        input_component_id: host.components['VCF IN'].id,
        output_component_id: expander.components.LP.id,
      });
    expect(route.status).toBe(201);

    const res = await request(f.app)
      .get(`/api/modules/${host.module.id}`)
      .set('Cookie', f.aliceCookie);
    expect(res.body.expanders).toMatchObject([
      { role: 'expander', manufacturer: 'Intellijel', name: 'Atlx' },  
    ]);
    expect(res.body.expander_components.map((c) => c.name)).toEqual(['LP']);
  });

  it('traces signal across the ribbon cable in a patch', async () => {
    const f = await fixture();
    const { host, expander } = await pair(f);
    await request(f.app)
      .post(`/api/modules/${host.module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({
        input_component_id: host.components['VCF IN'].id,
        output_component_id: expander.components.LP.id,
      });
    const { module: osc } = await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    // The host and its expander are linked automatically at creation.
    expect(body.links).toMatchObject([{ kind: 'expander' }]);

    const oscPm = instanceOf(body, 'A-110');
    const hostPm = instanceOf(body, 'Atlantix');
    const cable = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: oscPm.id,
        from_component_id: jack(oscPm, 'SAW').id,
        to_patch_module_id: hostPm.id,
        to_component_id: jack(hostPm, 'VCF IN').id,
      });
    expect(cable.status).toBe(201);

    body = await detail(f, patch.id);
    const rows = flatFlow(body);
    const lp = rows.find((n) => n.name === 'LP');
    expect(lp).toBeTruthy();
    expect(lp.via).toBe('route');
    // The expander jack belongs to the expander's own instance, not the host.
    expect(lp.patch_module_id).toBe(instanceOf(body, 'Atlx').id);
    expect(osc).toBeTruthy();
  });

  it('refuses to link a module to itself or twice', async () => {
    const f = await fixture();
    const { host, expander } = await pair(f);
    const again = await request(f.app)
      .post(`/api/modules/${expander.module.id}/expanders`)
      .set('Cookie', f.aliceCookie)
      .send({ expander_module_id: host.module.id });
    expect(again.status).toBe(409);

    const itself = await request(f.app)
      .post(`/api/modules/${host.module.id}/expanders`)
      .set('Cookie', f.aliceCookie)
      .send({ expander_module_id: host.module.id });
    expect(itself.status).toBe(400);
  });
});

describe('bridged instances (7Path)', () => {
  it('carries a signal from one panel to the matching jack on the other', async () => {
    const f = await fixture();
    // Two instances of a passive bridge module, jacks 1 and 2 on each.
    await withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path',
      quantity: 2,
      components: [
        { type: 'bidirectional_jack', name: '1', group: '1' },
        { type: 'bidirectional_jack', name: '2', group: '2' },
      ],
    });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const { module: filter } = await withComponents(f, {
      manufacturer: 'Mutable',
      name: 'Ripples',
      components: [{ type: 'input_jack', name: 'IN' }],
    });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    const a = instanceOf(body, '7Path', 1);
    const b = instanceOf(body, '7Path', 2);

    // Pairs up by jack name — jack 1 on one panel is jack 1 on the other.
    const link = await request(f.app)
      .post(`/api/patches/${patch.id}/links`)
      .set('Cookie', f.aliceCookie)
      .send({ a_patch_module_id: a.id, b_patch_module_id: b.id, kind: 'bridge' });
    expect(link.status).toBe(201);
    expect(link.body.jacks).toHaveLength(2);

    const oscPm = instanceOf(body, 'A-110');
    const filterPm = instanceOf(body, 'Ripples');
    // Oscillator → jack 1 of panel A; jack 1 of panel B → filter.
    for (const cable of [
      {
        from_patch_module_id: oscPm.id,
        from_component_id: jack(oscPm, 'SAW').id,
        to_patch_module_id: a.id,
        to_component_id: jack(a, '1').id,
      },
      {
        from_patch_module_id: b.id,
        from_component_id: jack(b, '1').id,
        to_patch_module_id: filterPm.id,
        to_component_id: jack(filterPm, 'IN').id,
      },
    ]) {
      const res = await request(f.app)
        .post(`/api/patches/${patch.id}/cables`)
        .set('Cookie', f.aliceCookie)
        .send(cable);
      expect(res.status).toBe(201);
    }

    body = await detail(f, patch.id);
    const rows = flatFlow(body);
    // SAW → jack 1 (panel A) → bridged → jack 1 (panel B) → filter IN.
    const bridged = rows.find((n) => n.via === 'bridge');
    expect(bridged).toMatchObject({ name: '1', patch_module_id: b.id });
    const arrived = rows.find((n) => n.name === 'IN');
    expect(arrived).toBeTruthy();
    expect(filter).toBeTruthy();
  });

  it('lets several ungrouped jacks of one panel take cables, unlike a mult', async () => {
    const f = await fixture();
    // 7Path's jacks carry independent signals, but nothing about their type
    // says so — left to the mult rules they would look like one group.
    await withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path',
      quantity: 2,
      components: [
        { type: 'bidirectional_jack', name: '1' },
        { type: 'bidirectional_jack', name: '2' },
      ],
    });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [
        { type: 'output_jack', name: 'SAW' },
        { type: 'output_jack', name: 'SQUARE' },
      ],
    });
    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    const a = instanceOf(body, '7Path', 1);
    const b = instanceOf(body, '7Path', 2);
    const osc = instanceOf(body, 'A-110');
    await request(f.app)
      .post(`/api/patches/${patch.id}/links`)
      .set('Cookie', f.aliceCookie)
      .send({ a_patch_module_id: a.id, b_patch_module_id: b.id, kind: 'bridge' });

    // Two different signals into two jacks of the same panel is exactly what
    // a bridge is for; a mult group would reject the second.
    for (const [out, jackName] of [
      ['SAW', '1'],
      ['SQUARE', '2'],
    ]) {
      const res = await request(f.app)
        .post(`/api/patches/${patch.id}/cables`)
        .set('Cookie', f.aliceCookie)
        .send({
          from_patch_module_id: osc.id,
          from_component_id: jack(osc, out).id,
          to_patch_module_id: a.id,
          to_component_id: jack(a, jackName).id,
        });
      expect(res.status).toBe(201);
    }

    // Each signal comes out of its own jack on the other panel, with no mult
    // copies between them.
    const after = await detail(f, patch.id);
    const bridged = flatFlow(after).filter((n) => n.via === 'bridge');
    expect(bridged.map((n) => n.name).sort()).toEqual(['1', '2']);
    expect(flatFlow(after).some((n) => n.via === 'mult')).toBe(false);
  });

  it('needs at least one matching pair of jacks', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path',
      components: [{ type: 'bidirectional_jack', name: '1' }],
    });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    const res = await request(f.app)
      .post(`/api/patches/${patch.id}/links`)
      .set('Cookie', f.aliceCookie)
      .send({
        a_patch_module_id: instanceOf(body, '7Path').id,
        b_patch_module_id: instanceOf(body, 'A-110').id,
        kind: 'bridge',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one pair of jacks/);
  });
});

describe('signal that leaves the rack', () => {
  it('patches off-rack gear into a module through a MIDI port', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Erica Synths',
      name: 'Drum Sequencer',
      components: [
        { type: 'input_jack', name: 'MIDI IN', port_kind: 'midi_din' },
        { type: 'output_jack', name: 'CV OUT' },
      ],
    });
    const patch = await createPatch(f);
    let body = await detail(f, patch.id);

    const gear = await request(f.app)
      .post(`/api/patches/${patch.id}/modules`)
      .set('Cookie', f.aliceCookie)
      .send({ name: 'UMC404HD', external: true, label: 'the computer' });
    expect(gear.status).toBe(201);
    expect(gear.body).toMatchObject({ external: true, live: false, label: 'the computer' });

    const port = await request(f.app)
      .post(`/api/patches/${patch.id}/modules/${gear.body.id}/ports`)
      .set('Cookie', f.aliceCookie)
      .send({ name: 'MIDI OUT', type: 'output_jack', port_kind: 'midi_din' });
    expect(port.status).toBe(201);

    body = await detail(f, patch.id);
    const seq = instanceOf(body, 'Drum Sequencer');
    const cable = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: gear.body.id,
        from_component_id: port.body.id,
        to_patch_module_id: seq.id,
        to_component_id: jack(seq, 'MIDI IN').id,
      });
    expect(cable.status).toBe(201);

    // The off-rack source is where the flow starts.
    body = await detail(f, patch.id);
    const root = body.flow.find((t) => t.patch_module_id === gear.body.id);
    expect(root).toMatchObject({ name: 'MIDI OUT', port_kind: 'midi_din' });
    expect(root.children[0]).toMatchObject({ name: 'MIDI IN', via: 'cable' });
  });

  it('refuses to join connections of different kinds', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Erica Synths',
      name: 'Drum Sequencer',
      components: [
        { type: 'input_jack', name: 'MIDI IN', port_kind: 'midi_din' },
        { type: 'output_jack', name: 'CV OUT' },
      ],
    });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    const seq = instanceOf(body, 'Drum Sequencer');
    const osc = instanceOf(body, 'A-110');
    const res = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: osc.id,
        from_component_id: jack(osc, 'SAW').id,
        to_patch_module_id: seq.id,
        to_component_id: jack(seq, 'MIDI IN').id,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/midi din/);
  });

  it('takes a port kind from the manual and from a correction', async () => {
    const f = await fixture();
    const module = await insertModule(f.db, f.alice.id, {
      manufacturer: 'Nervous Squirrel',
      name: "Conway's Game",
    });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'Game of life, or 64 MIDI-driven triggers.',
        components: [
          { type: 'input_jack', name: 'MIDI IN', port_kind: 'midi_din' },
          { type: 'output_jack', name: 'r0c0' },
          { type: 'input_jack', name: 'CLOCK IN', port_kind: 'nonsense' },
        ],
        normalizations: [],
      }),
    });
    await analyzeManualForModule(f.db, backend, module, '/tmp/x.pdf');
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    const byName = Object.fromEntries(res.body.components.map((c) => [c.name, c]));
    expect(byName['MIDI IN'].port_kind).toBe('midi_din');
    expect(byName['r0c0'].port_kind).toBe(null);
    // An unknown connector degrades rather than being dropped.
    expect(byName['CLOCK IN'].port_kind).toBe('other');

    const fixed = await request(f.app)
      .put(`/api/modules/${module.id}/components/${byName['CLOCK IN'].id}`)
      .set('Cookie', f.aliceCookie)
      .send({ port_kind: '' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.port_kind).toBe(null);

    const bad = await request(f.app)
      .put(`/api/modules/${module.id}/components/${byName['CLOCK IN'].id}`)
      .set('Cookie', f.aliceCookie)
      .send({ port_kind: 'smoke signals' });
    expect(bad.status).toBe(400);
  });
});

describe('output-side normals and stereo pairs', () => {
  // Forge TME Vhikk X: "the L output is normalled to the R output, so
  // patching a single cable from R provides a mono sum" — broken by a cable
  // LEAVING L, not by anything patched into R.
  it('breaks a normal on a cable out of another jack', async () => {
    const f = await fixture();
    const { module, components } = await withComponents(f, {
      manufacturer: 'Forge TME',
      name: 'Vhikk X',
      components: [
        { type: 'output_jack', name: 'L' },
        { type: 'output_jack', name: 'R' },
      ],
    });
    const { module: mixer } = await withComponents(f, {
      manufacturer: 'Erica Synths',
      name: 'Drum Mixer',
      components: [
        { type: 'input_jack', name: 'CH 1' },
        { type: 'input_jack', name: 'CH 2' },
      ],
    });
    const norm = await request(f.app)
      .post(`/api/modules/${module.id}/normalizations`)
      .set('Cookie', f.aliceCookie)
      .send({
        target_component_id: components.R.id,
        source_component_id: components.L.id,
        break_component_id: components.L.id,
        break_on: 'cable_out',
        description: 'Patching only R gives a mono sum.',
      });
    expect(norm.status).toBe(201);
    expect(norm.body).toMatchObject({ break_on: 'cable_out' });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    const vhikk = instanceOf(body, 'Vhikk X');
    const mix = instanceOf(body, 'Drum Mixer');

    // A cable out of R does not break it — R is the target.
    await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: vhikk.id,
        from_component_id: jack(vhikk, 'R').id,
        to_patch_module_id: mix.id,
        to_component_id: jack(mix, 'CH 1').id,
      });
    body = await detail(f, patch.id);
    expect(body.normalizations[0]).toMatchObject({ active: true, break_component_name: 'L' });

    // Patching L as well breaks it: the two outputs are now separate.
    await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: vhikk.id,
        from_component_id: jack(vhikk, 'L').id,
        to_patch_module_id: mix.id,
        to_component_id: jack(mix, 'CH 2').id,
      });
    body = await detail(f, patch.id);
    expect(body.normalizations[0]).toMatchObject({ active: false, break_on: 'cable_out' });
    expect(mixer).toBeTruthy();
  });

  it('patches both halves of a stereo pair in one step', async () => {
    const f = await fixture();
    const reverb = await withComponents(f, {
      manufacturer: 'Erica Synths',
      name: 'Stereo Reverb',
      components: [
        { type: 'output_jack', name: 'OUT L' },
        { type: 'output_jack', name: 'OUT R' },
      ],
    });
    const desk = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Mixup',
      components: [
        { type: 'input_jack', name: 'IN L' },
        { type: 'input_jack', name: 'IN R' },
      ],
    });
    for (const [module, a, b] of [
      [reverb.module.id, reverb.components['OUT L'].id, reverb.components['OUT R'].id],
      [desk.module.id, desk.components['IN L'].id, desk.components['IN R'].id],
    ]) {
      const res = await request(f.app)
        .post(`/api/modules/${module}/pairs`)
        .set('Cookie', f.aliceCookie)
        .send({ a_component_id: a, b_component_id: b });
      expect(res.status).toBe(201);
    }

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    expect(body.pairs).toHaveLength(2);
    const from = instanceOf(body, 'Stereo Reverb');
    const to = instanceOf(body, 'Mixup');
    const res = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: from.id,
        from_component_id: jack(from, 'OUT L').id,
        to_patch_module_id: to.id,
        to_component_id: jack(to, 'IN L').id,
        pair: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.paired_cable).toMatchObject({
      from_component_name: 'OUT R',
      to_component_name: 'IN R',
    });

    body = await detail(f, patch.id);
    expect(body.cables).toHaveLength(2);
  });

  it('keeps a jack in at most one pair', async () => {
    const f = await fixture();
    const { module, components } = await withComponents(f, {
      manufacturer: 'Qu-Bit',
      name: 'Nautilus',
      components: [
        { type: 'output_jack', name: 'L' },
        { type: 'output_jack', name: 'R' },
        { type: 'output_jack', name: 'SUM' },
      ],
    });
    const url = `/api/modules/${module.id}/pairs`;
    expect(
      (
        await request(f.app)
          .post(url)
          .set('Cookie', f.aliceCookie)
          .send({ a_component_id: components.L.id, b_component_id: components.R.id })
      ).status
    ).toBe(201);
    const clash = await request(f.app)
      .post(url)
      .set('Cookie', f.aliceCookie)
      .send({ a_component_id: components.L.id, b_component_id: components.SUM.id });
    expect(clash.status).toBe(409);

    const itself = await request(f.app)
      .post(url)
      .set('Cookie', f.aliceCookie)
      .send({ a_component_id: components.SUM.id, b_component_id: components.SUM.id });
    expect(itself.status).toBe(400);
  });

  it('extracts pairs from the manual and rewrites them on re-analysis', async () => {
    const f = await fixture();
    const module = await insertModule(f.db, f.alice.id, { manufacturer: 'Make Noise', name: 'Mimeophon' });
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'Stereo echo.',
        components: [
          { type: 'output_jack', name: 'OUT L' },
          { type: 'output_jack', name: 'OUT R' },
          { type: 'knob', name: 'Halo' },
        ],
        normalizations: [],
        pairs: [{ a: 'OUT L', b: 'OUT R', kind: 'stereo' }],
      }),
    });
    await analyzeManualForModule(f.db, backend, module, '/tmp/x.pdf');
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.pairs).toHaveLength(1);

    const backend2 = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'Stereo echo.',
        components: [{ type: 'output_jack', name: 'OUT L' }],
        normalizations: [],
        pairs: [],
      }),
    });
    await analyzeManualForModule(f.db, backend2, module, '/tmp/x.pdf');
    const after = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    expect(after.body.pairs).toEqual([]);
  });
});

describe('modules a patch does not use', () => {
  // A patch snapshots the whole rack. Tracing every module's internal paths
  // filled the flow with signals inside modules nothing was plugged into.
  it('keeps the signal flow to the modules the patch actually uses', async () => {
    const f = await fixture();
    const filter = await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-120',
      components: [
        { type: 'input_jack', name: 'AUDIO IN' },
        { type: 'output_jack', name: 'AUDIO OUT' },
      ],
    });
    await request(f.app)
      .post(`/api/modules/${filter.module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({
        input_component_id: filter.components['AUDIO IN'].id,
        output_component_id: filter.components['AUDIO OUT'].id,
      });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    // An idle module with a normalled connection of its own.
    const idle = await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-140',
      components: [
        { type: 'input_jack', name: 'GATE' },
        { type: 'output_jack', name: 'ENV OUT' },
      ],
    });
    await request(f.app)
      .post(`/api/modules/${idle.module.id}/normalizations`)
      .set('Cookie', f.aliceCookie)
      .send({ target_component_id: idle.components['GATE'].id, source_label: 'internal clock' });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    // Nothing is patched yet, so nothing flows — not even the paths inside
    // the modules sitting in the rack.
    expect(body.flow).toEqual([]);

    const oscPm = instanceOf(body, 'A-110');
    const filterPm = instanceOf(body, 'A-120');
    const res = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: oscPm.id,
        from_component_id: jack(oscPm, 'SAW').id,
        to_patch_module_id: filterPm.id,
        to_component_id: jack(filterPm, 'AUDIO IN').id,
      });
    expect(res.status).toBe(201);

    body = await detail(f, patch.id);
    const names = flatFlow(body).map((n) => n.name);
    // The cabled pair traces all the way across the filter...
    expect(names).toEqual(['SAW', 'AUDIO IN', 'AUDIO OUT']);
    // ...and the module no cable reaches contributes nothing.
    expect(names).not.toContain('internal clock');
    expect(names).not.toContain('GATE');
  });

  it('brings a module into the flow once the patch dials one of its controls in', async () => {
    const f = await fixture();
    const drone = await withComponents(f, {
      manufacturer: 'Make Noise',
      name: 'DPO',
      components: [
        { type: 'input_jack', name: 'FM' },
        { type: 'output_jack', name: 'SINE' },
        { type: 'knob', name: 'FREQ' },
      ],
    });
    await request(f.app)
      .post(`/api/modules/${drone.module.id}/normalizations`)
      .set('Cookie', f.aliceCookie)
      .send({ target_component_id: drone.components['FM'].id, source_label: 'internal LFO' });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    expect(body.flow).toEqual([]);

    const pm = instanceOf(body, 'DPO');
    const res = await request(f.app)
      .put(`/api/patches/${patch.id}/settings`)
      .set('Cookie', f.aliceCookie)
      .send({ patch_module_id: pm.id, component_id: jack(pm, 'FREQ').id, value: '3' });
    expect(res.status).toBe(201);

    body = await detail(f, patch.id);
    expect(flatFlow(body).map((n) => n.name)).toContain('internal LFO');
  });
});

describe('patch bookkeeping', () => {
  it('labels instances, files them under buses, and adds modules the rack lacks', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Erica Synths',
      name: 'LXR',
      quantity: 2,
      components: [{ type: 'output_jack', name: 'OUT' }],
    });
    const patch = await createPatch(f);
    let body = await detail(f, patch.id);

    const group = await request(f.app)
      .post(`/api/patches/${patch.id}/groups`)
      .set('Cookie', f.aliceCookie)
      .send({ name: 'Rhythm' });
    expect(group.status).toBe(201);
    expect(
      (
        await request(f.app)
          .post(`/api/patches/${patch.id}/groups`)
          .set('Cookie', f.aliceCookie)
          .send({ name: 'rhythm' })
      ).status
    ).toBe(409);

    const first = instanceOf(body, 'LXR', 1);
    const labeled = await request(f.app)
      .put(`/api/patches/${patch.id}/modules/${first.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ label: 'snare voice', group_id: group.body.id });
    expect(labeled.status).toBe(200);
    expect(labeled.body).toMatchObject({ label: 'snare voice', group_id: group.body.id });

    // A module the rack does not hold, with the jacks the patch needs.
    const borrowed = await request(f.app)
      .post(`/api/patches/${patch.id}/modules`)
      .set('Cookie', f.aliceCookie)
      .send({ manufacturer: 'Doepfer', module_name: 'A-140' });
    expect(borrowed.status).toBe(201);
    expect(borrowed.body).toMatchObject({ live: false, external: false });
    const port = await request(f.app)
      .post(`/api/patches/${patch.id}/modules/${borrowed.body.id}/ports`)
      .set('Cookie', f.aliceCookie)
      .send({ name: 'ENV OUT', type: 'output_jack' });
    expect(port.status).toBe(201);
    expect(
      (
        await request(f.app)
          .post(`/api/patches/${patch.id}/modules/${borrowed.body.id}/ports`)
          .set('Cookie', f.aliceCookie)
          .send({ name: 'env out' })
      ).status
    ).toBe(409);

    body = await detail(f, patch.id);
    expect(body.groups).toMatchObject([{ name: 'Rhythm' }]);
    expect(instanceOf(body, 'LXR', 1)).toMatchObject({ label: 'snare voice' });
    const a140 = instanceOf(body, 'A-140');
    expect(a140.components.map((c) => c.name)).toEqual(['ENV OUT']);

    // Deleting the group leaves its members in the patch.
    await request(f.app)
      .delete(`/api/patches/${patch.id}/groups/${group.body.id}`)
      .set('Cookie', f.aliceCookie);
    body = await detail(f, patch.id);
    expect(body.groups).toEqual([]);
    expect(instanceOf(body, 'LXR', 1)).toMatchObject({ group_id: null, label: 'snare voice' });
  });

  it('annotates cables and removes an instance with everything patched into it', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Schlappi',
      name: '100 Grit',
      components: [
        { type: 'input_jack', name: 'IN' },
        { type: 'output_jack', name: 'OUT' },
      ],
    });
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    const grit = instanceOf(body, '100 Grit');
    const osc = instanceOf(body, 'A-110');

    const cable = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: osc.id,
        from_component_id: jack(osc, 'SAW').id,
        to_patch_module_id: grit.id,
        to_component_id: jack(grit, 'IN').id,
        note: 'adds the distortion layer',
        optional: true,
        stacked: true,
        alt_group: 'drive choice',
      });
    expect(cable.status).toBe(201);
    expect(cable.body).toMatchObject({
      note: 'adds the distortion layer',
      optional: true,
      stacked: true,
      alt_group: 'drive choice',
    });

    const edited = await request(f.app)
      .put(`/api/patches/${patch.id}/cables/${cable.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ optional: false, note: '' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ optional: false, note: null, stacked: true });

    // Removing the instance takes its cables with it.
    const removed = await request(f.app)
      .delete(`/api/patches/${patch.id}/modules/${grit.id}`)
      .set('Cookie', f.aliceCookie);
    expect(removed.status).toBe(200);
    body = await detail(f, patch.id);
    expect(body.cables).toEqual([]);
    expect(body.modules.some((m) => m.module_name === '100 Grit')).toBe(false);
  });

  it('keeps patches private to their owner', async () => {
    const f = await fixture();
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const patch = await createPatch(f);
    for (const [method, url] of [
      ['post', `/api/patches/${patch.id}/groups`],
      ['post', `/api/patches/${patch.id}/modules`],
      ['post', `/api/patches/${patch.id}/links`],
    ]) {
      const res = await request(f.app)[method](url).set('Cookie', f.adminCookie).send({ name: 'x' });
      expect(res.status).toBe(404);
    }
  });
});

describe('flow budget', () => {
  it('flags a tree that was cut short instead of silently truncating it', () => {
    // A chain of instances longer than the tracer follows in one tree.
    const length = MAX_FLOW_NODES + 20;
    const patchModules = [];
    const componentsByModule = new Map();
    const cables = [];
    for (let i = 0; i < length; i += 1) {
      patchModules.push({ id: i + 1, module_id: i + 1 });
      componentsByModule.set(i + 1, [
        { id: 1, type: 'input_jack', name: `IN ${i}` },
        { id: 2, type: 'output_jack', name: `OUT ${i}` },
      ]);
      if (i > 0) {
        cables.push({
          id: i,
          from_patch_module_id: i,
          from_component_id: 2,
          from_component_name: `OUT ${i - 1}`,
          to_patch_module_id: i + 1,
          to_component_id: 1,
          to_component_name: `IN ${i}`,
        });
      }
    }
    // Each module passes its input to its output, so the chain is continuous.
    // Every module but the first passes its input through; the first is a
    // generator, which is where the tree starts.
    const routesByModule = new Map(
      [...componentsByModule.keys()]
        .filter((id) => id !== 1)
        .map((id) => [id, [{ id, input_component_id: 1, output_component_id: 2 }]])
    );
    const trees = buildSignalFlow(
      buildPatchTopology({ patchModules, componentsByModule, routesByModule, cables })
    );
    const walk = (node, out = []) => {
      out.push(node);
      for (const child of node.children || []) walk(child, out);
      return out;
    };
    const rows = walk(trees[0]);
    expect(trees[0].truncated_tree).toBe(true);
    expect(rows.some((n) => n.truncated)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(MAX_FLOW_NODES + 1);
  });
});

// One manual, two panels. Analysis is per module but manuals are per
// instrument, so a host's manual routinely describes its expander's jacks and
// the signal paths that run between the two.
describe('manuals that cover more than one panel', () => {
  const atlantixAnalysis = {
    summary: 'Dual oscillator voice with an optional expander.',
    components: [
      { type: 'input_jack', name: 'VCF IN' },
      { type: 'output_jack', name: 'MIXER OUT' },
      // Documented in the same manual, but physically on the expander.
      { type: 'output_jack', name: 'LP', panel: 'Atlx' },
      { type: 'output_jack', name: 'HP', panel: 'Atlx' },
    ],
    normalizations: [],
    routes: [
      { input: 'VCF IN', output: 'LP', output_panel: 'Atlx' },
      { input: 'VCF IN', output: 'MIXER OUT' },
    ],
    expanders: [{ name: 'Atlx', role: 'expander' }],
  };

  async function analyze(f, module, analysis) {
    await analyzeManualForModule(f.db, fakeBackend({ analyzeDocument: JSON.stringify(analysis) }), module, '/tmp/x.pdf');
  }

  it('keeps another panel’s jacks off this module’s inventory', async () => {
    const f = await fixture();
    const module = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlantix' });
    await analyze(f, module, atlantixAnalysis);
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.components.map((c) => c.name).sort()).toEqual(['MIXER OUT', 'VCF IN']);
    // The path that stays on this panel is stored as usual.
    expect(res.body.routes).toHaveLength(1);
  });

  it('resolves a cross-panel path once the other panel is analyzed and linked', async () => {
    const f = await fixture();
    const host = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlantix' });
    await analyze(f, host, atlantixAnalysis);
    // Nothing to resolve against yet: the expander is not even imported.
    let res = await request(f.app).get(`/api/modules/${host.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.routes).toHaveLength(1);
    expect(res.body.expander_suggestions).toMatchObject([{ name: 'Atlx', module_id: null }]);

    // Import and analyze the expander: the manual named it, so the two module
    // records link themselves and the cross-panel path appears.
    const expander = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlx' });
    await analyze(f, expander, {
      summary: 'Atlantix expander.',
      components: [
        { type: 'output_jack', name: 'LP' },
        { type: 'output_jack', name: 'HP' },
      ],
      normalizations: [],
      routes: [],
      expanders: [{ name: 'Atlantix', role: 'host' }],
    });

    res = await request(f.app).get(`/api/modules/${host.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.expanders).toMatchObject([{ role: 'expander', name: 'Atlx' }]);
    expect(res.body.expander_suggestions).toEqual([]);
    expect(res.body.routes).toHaveLength(2);
    const crossPanel = res.body.routes.find(
      (r) => !res.body.components.some((c) => c.id === r.output_component_id)
    );
    expect(crossPanel).toBeTruthy();
    expect(res.body.expander_components.find((c) => c.id === crossPanel.output_component_id).name).toBe('LP');

    // And it survives re-analysis of the expander, which renumbers its
    // components and cascades the resolved row away.
    await analyze(f, expander, {
      summary: 'Atlantix expander.',
      components: [
        { type: 'output_jack', name: 'LP' },
        { type: 'output_jack', name: 'BP' },
      ],
      normalizations: [],
      routes: [],
      expanders: [],
    });
    res = await request(f.app).get(`/api/modules/${host.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.routes).toHaveLength(2);
  });

  it('resolves a cross-panel path when the user links the panels by hand', async () => {
    const f = await fixture();
    const host = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlantix' });
    await analyze(f, host, atlantixAnalysis);
    // A panel whose name the manual's wording does not match.
    const expander = await insertModule(f.db, f.alice.id, { manufacturer: 'Intellijel', name: 'Atlx' });
    await f.db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'LP')`,
      [expander.id]
    );
    const link = await request(f.app)
      .post(`/api/modules/${host.id}/expanders`)
      .set('Cookie', f.aliceCookie)
      .send({ expander_module_id: expander.id });
    expect(link.status).toBe(201);

    const res = await request(f.app).get(`/api/modules/${host.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.routes).toHaveLength(2);
  });

  it('links a module whose name says it is an expander', async () => {
    const f = await fixture();
    const host = await insertModule(f.db, f.alice.id, {
      manufacturer: 'Humble Audio',
      name: 'Quad Operator',
    });
    const expander = await insertModule(f.db, f.alice.id, {
      manufacturer: 'Humble Audio',
      name: 'Quad Operator Algo Extension',
    });
    // Both records share one manual; analyzing the expander links the pair by
    // name even though this analysis names no panel.
    await analyze(f, expander, {
      summary: 'Algo extension.',
      components: [{ type: 'button', name: 'A' }],
      normalizations: [],
      routes: [],
    });
    const res = await request(f.app).get(`/api/modules/${host.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.expanders).toMatchObject([
      { role: 'expander', name: 'Quad Operator Algo Extension' },
    ]);
  });

  it('keeps every component when the panel tags name nothing this module owns', async () => {
    const f = await fixture();
    // Analyzing the expander against the host's manual: if the analysis tags
    // everything with a panel name that does not match this record, dropping
    // it all would leave the module empty — so the tags are ignored instead.
    const module = await insertModule(f.db, f.alice.id, {
      manufacturer: 'Ohmforce',
      name: 'Bohm Groove Sequence Expander',
    });
    await analyze(f, module, {
      summary: 'Groove.',
      components: [
        { type: 'button', name: 'STEP 1', panel: 'Groove' },
        { type: 'button', name: 'STEP 2', panel: 'Groove' },
      ],
      normalizations: [],
      routes: [],
    });
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    expect(res.body.components.map((c) => c.name)).toEqual(['STEP 1', 'STEP 2']);
  });
});

describe('discrete controls with many positions', () => {
  it('keeps every position of a switch, not just the first and last', async () => {
    const f = await fixture();
    const module = await insertModule(f.db, f.alice.id, { manufacturer: 'Forge TME', name: 'Vhikk X' });
    const algorithms = Array.from({ length: 8 }, (_, i) => `Algorithm ${i + 1}`);
    await analyzeManualForModule(
      f.db,
      fakeBackend({
        analyzeDocument: JSON.stringify({
          summary: 'The signal path is algorithm-dependent.',
          components: [
            { type: 'switch', name: 'ALGORITHM', value_options: algorithms },
            // A knob with a long list of labels is still a range.
            { type: 'knob', name: 'TIME', value_options: ['1', '2', '3', '4', '5', '6'] },
          ],
          normalizations: [],
        }),
      }),
      module,
      '/tmp/x.pdf'
    );
    const res = await request(f.app).get(`/api/modules/${module.id}`).set('Cookie', f.aliceCookie);
    const byName = Object.fromEntries(res.body.components.map((c) => [c.name, c]));
    expect(byName.ALGORITHM.values.map((v) => v.value)).toEqual(algorithms);
    expect(byName.TIME.values.map((v) => [v.type, v.value])).toEqual([
      ['min', '1'],
      ['max', '6'],
    ]);

    // A middle position can therefore gate a signal path.
    const jacks = await f.db.query(
      `INSERT INTO module_components (module_id, type, name)
       VALUES ($1, 'input_jack', 'IN'), ($1, 'output_jack', 'OUT') RETURNING *`,
      [module.id]
    );
    const route = await request(f.app)
      .post(`/api/modules/${module.id}/routes`)
      .set('Cookie', f.aliceCookie)
      .send({
        input_component_id: jacks.rows[0].id,
        output_component_id: jacks.rows[1].id,
        condition_component_id: byName.ALGORITHM.id,
        condition_value: 'Algorithm 5',
      });
    expect(route.status).toBe(201);
  });
});

describe('managing links between instances', () => {
  // Two 7Path panels in the rack, ready to be bridged.
  async function bridgeable(f) {
    await withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path',
      quantity: 2,
      components: [
        { type: 'bidirectional_jack', name: '1' },
        { type: 'bidirectional_jack', name: '2' },
      ],
    });
    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    return { patch, a: instanceOf(body, '7Path', 1), b: instanceOf(body, '7Path', 2) };
  }

  it('validates link creation and refuses the same pair twice', async () => {
    const f = await fixture();
    const { patch, a, b } = await bridgeable(f);
    const post = (body) =>
      request(f.app).post(`/api/patches/${patch.id}/links`).set('Cookie', f.aliceCookie).send(body);

    const stranger = await post({ a_patch_module_id: a.id, b_patch_module_id: 99999 });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toMatch(/part of this patch/);

    const itself = await post({ a_patch_module_id: a.id, b_patch_module_id: a.id });
    expect(itself.status).toBe(400);
    expect(itself.body.error).toMatch(/linked to itself/);

    const rope = await post({ a_patch_module_id: a.id, b_patch_module_id: b.id, kind: 'rope' });
    expect(rope.status).toBe(400);
    expect(rope.body.error).toMatch(/kind must be one of/);

    // No kind means an expander pair: no jack pairing involved.
    const made = await post({
      a_patch_module_id: a.id,
      b_patch_module_id: b.id,
      description: ' ribbon ',
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'expander', description: 'ribbon', jacks: [] });

    // The same pair in either order is already linked.
    const reversed = await post({
      a_patch_module_id: b.id,
      b_patch_module_id: a.id,
      kind: 'bridge',
    });
    expect(reversed.status).toBe(409);
  });

  it('pairs explicitly named jacks and unlinks the instances again', async () => {
    const f = await fixture();
    const { patch, a, b } = await bridgeable(f);
    const post = (body) =>
      request(f.app).post(`/api/patches/${patch.id}/links`).set('Cookie', f.aliceCookie).send(body);

    // Every requested pair must name a jack on each of the two panels.
    const half = await post({
      a_patch_module_id: a.id,
      b_patch_module_id: b.id,
      kind: 'bridge',
      jacks: [{ a_component_id: jack(a, '1').id, b_component_id: 99999 }],
    });
    expect(half.status).toBe(400);
    expect(half.body.error).toMatch(/jack on each of the two modules/);

    // An explicit list overrides the by-name pairing: jack 1 onto jack 2.
    const made = await post({
      a_patch_module_id: a.id,
      b_patch_module_id: b.id,
      kind: 'bridge',
      jacks: [{ a_component_id: jack(a, '1').id, b_component_id: jack(b, '2').id }],
    });
    expect(made.status).toBe(201);
    expect(made.body.jacks).toEqual([
      {
        a_component_id: jack(a, '1').id,
        a_component_name: '1',
        b_component_id: jack(b, '2').id,
        b_component_name: '2',
      },
    ]);

    const unlink = (linkId) =>
      request(f.app)
        .delete(`/api/patches/${patch.id}/links/${linkId}`)
        .set('Cookie', f.aliceCookie);
    expect((await unlink('abc')).status).toBe(404);
    expect((await unlink(made.body.id)).status).toBe(200);
    expect((await detail(f, patch.id)).links).toEqual([]);
    const { rows } = await f.db.query(
      'SELECT id FROM patch_module_link_jacks WHERE link_id = $1',
      [made.body.id]
    );
    expect(rows).toEqual([]);
    expect((await unlink(made.body.id)).status).toBe(404);
  });

  it('unlinks an expander pair from either side', async () => {
    const f = await fixture();
    const host = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Atlantix',
      components: [{ type: 'input_jack', name: 'VCF IN' }],
    });
    const expander = await withComponents(f, {
      manufacturer: 'Intellijel',
      name: 'Atlx',
      components: [{ type: 'output_jack', name: 'LP' }],
    });
    const link = () =>
      request(f.app)
        .post(`/api/modules/${host.module.id}/expanders`)
        .set('Cookie', f.aliceCookie)
        .send({ expander_module_id: expander.module.id, description: ' ribbon cable ' });
    const unlink = (moduleId, linkId) =>
      request(f.app)
        .delete(`/api/modules/${moduleId}/expanders/${linkId}`)
        .set('Cookie', f.aliceCookie);

    // Only a module in one of your racks can be declared an expander.
    const unracked = await request(f.app)
      .post(`/api/modules/${host.module.id}/expanders`)
      .set('Cookie', f.aliceCookie)
      .send({ expander_module_id: 99999 });
    expect(unracked.status).toBe(400);
    expect(unracked.body.error).toMatch(/one of your racks/);

    let made = await link();
    expect(made.status).toBe(201);
    expect(made.body.description).toBe('ribbon cable');

    // The expander side may unlink a pair the host side declared.
    expect((await unlink(expander.module.id, made.body.id)).status).toBe(200);
    const after = await request(f.app)
      .get(`/api/modules/${host.module.id}`)
      .set('Cookie', f.aliceCookie);
    expect(after.body.expanders).toEqual([]);

    made = await link();
    expect((await unlink(host.module.id, made.body.id)).status).toBe(200);
    expect((await unlink(host.module.id, made.body.id)).status).toBe(404);
    expect((await unlink(host.module.id, 'abc')).status).toBe(404);
  });
});

describe('dual modules (declared on the hardware)', () => {
  // A 7Path pair is ONE module record racked twice: the two panels are
  // instance 1 and instance 2, joined by an ethernet cable rather than by
  // patch cables.
  async function dual(f, { quantity = 2 } = {}) {
    return withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path',
      quantity,
      components: [
        { type: 'bidirectional_jack', name: '1', group: '1' },
        { type: 'bidirectional_jack', name: '2', group: '2' },
      ],
    });
  }

  const declare = (f, moduleId, body) =>
    request(f.app)
      .post(`/api/modules/${moduleId}/bridges`)
      .set('Cookie', f.aliceCookie)
      .send(body);

  it('wires every patch built from the rack, without being asked', async () => {
    const f = await fixture();
    const { module } = await dual(f);
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [{ type: 'output_jack', name: 'SAW' }],
    });
    const { module: filter } = await withComponents(f, {
      manufacturer: 'Mutable',
      name: 'Ripples',
      components: [{ type: 'input_jack', name: 'IN' }],
    });
    expect(filter).toBeTruthy();

    const declared = await declare(f, module.id, { bridge_module_id: module.id });
    expect(declared.status).toBe(201);
    expect(declared.body).toMatchObject({ self: true, module_id: module.id });

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    // The pair is linked in the fresh patch — nobody declared it there.
    expect(body.links).toHaveLength(1);
    expect(body.links[0].kind).toBe('bridge');
    expect(body.links[0].jacks.map((j) => j.a_component_name).sort()).toEqual(['1', '2']);

    const a = instanceOf(body, '7Path', 1);
    const b = instanceOf(body, '7Path', 2);
    const osc = instanceOf(body, 'A-110');
    const ripples = instanceOf(body, 'Ripples');
    for (const cable of [
      {
        from_patch_module_id: osc.id,
        from_component_id: jack(osc, 'SAW').id,
        to_patch_module_id: a.id,
        to_component_id: jack(a, '1').id,
      },
      {
        from_patch_module_id: b.id,
        from_component_id: jack(b, '1').id,
        to_patch_module_id: ripples.id,
        to_component_id: jack(ripples, 'IN').id,
      },
    ]) {
      const res = await request(f.app)
        .post(`/api/patches/${patch.id}/cables`)
        .set('Cookie', f.aliceCookie)
        .send(cable);
      expect(res.status).toBe(201);
    }
    body = await detail(f, patch.id);
    const bridged = flatFlow(body).find((n) => n.via === 'bridge');
    expect(bridged).toMatchObject({ name: '1', patch_module_id: b.id });
  });

  it('takes the input at one end of a wire only', async () => {
    const f = await fixture();
    const { module } = await dual(f);
    await withComponents(f, {
      manufacturer: 'Doepfer',
      name: 'A-110',
      components: [
        { type: 'output_jack', name: 'SAW' },
        { type: 'output_jack', name: 'SQUARE' },
      ],
    });
    expect((await declare(f, module.id, { bridge_module_id: module.id })).status).toBe(201);

    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    const a = instanceOf(body, '7Path', 1);
    const b = instanceOf(body, '7Path', 2);
    const osc = instanceOf(body, 'A-110');
    const cable = (payload) =>
      request(f.app)
        .post(`/api/patches/${patch.id}/cables`)
        .set('Cookie', f.aliceCookie)
        .send(payload);

    const first = await cable({
      from_patch_module_id: osc.id,
      from_component_id: jack(osc, 'SAW').id,
      to_patch_module_id: a.id,
      to_component_id: jack(a, '1').id,
    });
    expect(first.status).toBe(201);

    // The far end of that wire is now the OUTPUT; a second source cannot
    // drive it from the other panel.
    const clash = await cable({
      from_patch_module_id: osc.id,
      from_component_id: jack(osc, 'SQUARE').id,
      to_patch_module_id: b.id,
      to_component_id: jack(b, '1').id,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already the input of that bridged wire/);

    // ... and the driven end does not also send the signal back out.
    const backwards = await cable({
      from_patch_module_id: a.id,
      from_component_id: jack(a, '1').id,
      to_patch_module_id: b.id,
      to_component_id: jack(b, '2').id,
    });
    expect(backwards.status).toBe(409);
    expect(backwards.body.error).toMatch(/is the input end of that bridged wire/);

    // The other wire of the same pair is free, in either direction.
    const other = await cable({
      from_patch_module_id: osc.id,
      from_component_id: jack(osc, 'SQUARE').id,
      to_patch_module_id: b.id,
      to_component_id: jack(b, '2').id,
    });
    expect(other.status).toBe(201);
  });

  it('refuses a cable between the two ends of one wire', async () => {
    const f = await fixture();
    const { module } = await dual(f);
    expect((await declare(f, module.id, { bridge_module_id: module.id })).status).toBe(201);
    const patch = await createPatch(f);
    const body = await detail(f, patch.id);
    const a = instanceOf(body, '7Path', 1);
    const b = instanceOf(body, '7Path', 2);
    const res = await request(f.app)
      .post(`/api/patches/${patch.id}/cables`)
      .set('Cookie', f.aliceCookie)
      .send({
        from_patch_module_id: a.id,
        from_component_id: jack(a, '1').id,
        to_patch_module_id: b.id,
        to_component_id: jack(b, '1').id,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/two ends of one bridged wire/);
  });

  it('links the pair when the second panel joins a patch later', async () => {
    const f = await fixture();
    const { module } = await dual(f);
    expect((await declare(f, module.id, { bridge_module_id: module.id })).status).toBe(201);
    const patch = await createPatch(f);

    // Drop one panel out of the patch and put it back: the pair re-forms.
    let body = await detail(f, patch.id);
    const b = instanceOf(body, '7Path', 2);
    expect(
      (
        await request(f.app)
          .delete(`/api/patches/${patch.id}/modules/${b.id}`)
          .set('Cookie', f.aliceCookie)
      ).status
    ).toBe(200);
    body = await detail(f, patch.id);
    expect(body.links).toHaveLength(0);

    const added = await request(f.app)
      .post(`/api/patches/${patch.id}/modules`)
      .set('Cookie', f.aliceCookie)
      .send({ module_id: module.id });
    expect(added.status).toBe(201);
    body = await detail(f, patch.id);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].kind).toBe('bridge');
  });

  it('needs a second panel before a module is its own other half', async () => {
    const f = await fixture();
    const { module } = await dual(f, { quantity: 1 });
    const res = await declare(f, module.id, { bridge_module_id: module.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/two of them/);

    // Two separate records whose panels share no jack names cannot pair up.
    const { module: other } = await withComponents(f, {
      manufacturer: 'Omnitone',
      name: '7Path Mini',
      components: [{ type: 'bidirectional_jack', name: 'A' }],
    });
    const mismatch = await declare(f, module.id, { bridge_module_id: other.id });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toMatch(/share no jack names/);
  });

  it('pairs two separate records, wire by wire, and unlinks from either panel', async () => {
    const f = await fixture();
    const { module: send, components: sendJacks } = await withComponents(f, {
      manufacturer: 'Omnitone',
      name: 'Path A',
      components: [{ type: 'bidirectional_jack', name: 'A1' }],
    });
    const { module: receive, components: receiveJacks } = await withComponents(f, {
      manufacturer: 'Omnitone',
      name: 'Path B',
      components: [{ type: 'bidirectional_jack', name: 'B1' }],
    });
    const declared = await declare(f, send.id, {
      bridge_module_id: receive.id,
      jacks: [{ a_component_id: sendJacks.A1.id, b_component_id: receiveJacks.B1.id }],
    });
    expect(declared.status).toBe(201);
    expect(declared.body.self).toBe(false);

    const patch = await createPatch(f);
    let body = await detail(f, patch.id);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].jacks[0]).toMatchObject({ a_component_name: 'A1', b_component_name: 'B1' });

    // The far panel's page shows the same pair and can undo it.
    const far = await request(f.app)
      .get(`/api/modules/${receive.id}`)
      .set('Cookie', f.aliceCookie);
    expect(far.status).toBe(200);
    expect(far.body.bridges).toHaveLength(1);
    expect(far.body.bridges[0]).toMatchObject({ module_id: send.id, self: false });
    const removed = await request(f.app)
      .delete(`/api/modules/${receive.id}/bridges/${far.body.bridges[0].id}`)
      .set('Cookie', f.aliceCookie);
    expect(removed.status).toBe(200);

    // Patches already built keep the pair they were built with.
    body = await detail(f, patch.id);
    expect(body.links).toHaveLength(1);
    const fresh = await detail(f, (await createPatch(f, 'Later patch')).id);
    expect(fresh.links).toHaveLength(0);
  });
});
