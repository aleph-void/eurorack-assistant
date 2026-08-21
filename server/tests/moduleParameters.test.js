// Menu parameters: the settings a module keeps behind an encoder and a screen
// rather than under a control of its own — and the values a patch records for
// them.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, fakeBackend, insertModule, login } from './helpers.js';
import { findParametersForModule } from '../src/services/moduleParameters.js';
import { patchTextDocument } from '../src/services/patchDocument.js';

// alice has ALM's Pamela's Pro Workout in her rack: one encoder, one screen
// and two outputs whose whole behaviour lives in a menu.
async function withMenuModule() {
  const fixture = await createTestApp();
  const { db } = fixture;
  fixture.alice = await db.models.User.findOne({ where: { username: 'alice' } });
  fixture.module = await insertModule(db, fixture.alice.id, {
    manufacturer: 'ALM',
    name: "Pamela's Pro Workout",
  });
  const { rows } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'output_jack', 'OUT 1'),
     ($1, 'output_jack', 'OUT 2'),
     ($1, 'knob', 'Encoder') RETURNING *`,
    [fixture.module.id]
  );
  fixture.out1 = rows.find((c) => c.name === 'OUT 1');
  fixture.out2 = rows.find((c) => c.name === 'OUT 2');
  fixture.encoder = rows.find((c) => c.name === 'Encoder');
  return fixture;
}

const post = (ctx, path, body) =>
  request(ctx.app).post(path).set('Cookie', ctx.aliceCookie).send(body);
const put = (ctx, path, body) =>
  request(ctx.app).put(path).set('Cookie', ctx.aliceCookie).send(body);
const get = (ctx, path) => request(ctx.app).get(path).set('Cookie', ctx.aliceCookie);

describe('findParametersForModule', () => {
  it('records the menu, its options, and which jack each setting belongs to', async () => {
    const ctx = await withMenuModule();
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        parameters: [
          {
            name: 'Clock division',
            component: 'OUT 1',
            group: 'Output settings',
            value_type: 'enum',
            options: [
              { value: '/4', description: 'Four times slower' },
              { value: 'x2' },
              '',
            ],
            default: 'x1',
            description: 'How fast this output runs against the master clock.',
          },
          // No type stated and no options: a range, read off min/max.
          { name: 'Tempo', component: null, value_min: 10, value_max: 300, unit: 'BPM' },
          // Names a component this module does not have — kept, as a
          // parameter of the module itself, rather than dropped.
          { name: 'Swing', component: 'OUT 9' },
          { name: '' },
        ],
      }),
    });
    const result = await findParametersForModule(ctx.db, backend, ctx.module, '/tmp/pams.pdf');
    expect(result).toEqual({ asked: 3, created: 3, options: 0 });

    const rows = await ctx.db.models.ModuleParameter.findAll({ order: [['id', 'ASC']] });
    expect(rows.map((r) => [r.name, r.component_id, r.value_type])).toEqual([
      ['Clock division', ctx.out1.id, 'enum'],
      ['Tempo', null, 'text'],
      ['Swing', null, 'text'],
    ]);
    expect(rows[0].default_value).toBe('x1');
    expect(rows[1].value_min).toBe('10');
    expect(rows[1].unit).toBe('BPM');
    const options = await ctx.db.models.ModuleParameterOption.findAll({
      where: { parameter_id: rows[0].id },
      order: [['position', 'ASC']],
    });
    expect(options.map((o) => o.value)).toEqual(['/4', 'x2']);
    expect(options[0].description).toBe('Four times slower');

    // The prompt names the module's components, so a parameter can say which
    // one it configures.
    const [prompt, path] = backend.calls.analyzeDocument[0];
    expect(path).toBe('/tmp/pams.pdf');
    expect(prompt).toContain('"OUT 1" (output jack)');
    expect(prompt).toContain('menu');
  });

  it('adds only: a recorded parameter is never rewritten, an empty option list is filled', async () => {
    const ctx = await withMenuModule();
    const kept = await ctx.db.models.ModuleParameter.create({
      module_id: ctx.module.id,
      component_id: ctx.out1.id,
      name: 'Clock division',
      value_type: 'enum',
      description: 'What I typed myself.',
    });
    const described = await ctx.db.models.ModuleParameter.create({
      module_id: ctx.module.id,
      component_id: ctx.out2.id,
      name: 'Wave',
      value_type: 'enum',
    });
    await ctx.db.models.ModuleParameterOption.create({
      parameter_id: described.id,
      value: 'Square',
    });

    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        parameters: [
          {
            name: 'clock division',
            component: 'OUT 1',
            description: 'Something the model made up.',
            options: [{ value: '/8' }],
          },
          { name: 'Wave', component: 'OUT 2', options: [{ value: 'Triangle' }, { value: 'Ramp' }] },
          { name: 'Level', component: 'OUT 1', options: [{ value: '100%' }] },
        ],
      }),
    });
    const result = await findParametersForModule(ctx.db, backend, ctx.module, '/tmp/pams.pdf');
    expect(result).toEqual({ asked: 3, created: 1, options: 1 });

    await kept.reload();
    expect(kept.description).toBe('What I typed myself.');
    // The parameter that had no options gets the list; the one that had one
    // keeps exactly what was there.
    const optionsFor = async (parameter) =>
      (
        await ctx.db.models.ModuleParameterOption.findAll({
          where: { parameter_id: parameter.id },
          order: [['position', 'ASC']],
        })
      ).map((o) => o.value);
    expect(await optionsFor(kept)).toEqual(['/8']);
    expect(await optionsFor(described)).toEqual(['Square']);
  });
});

describe('the module parameter routes', () => {
  it('adds, corrects and removes a parameter and its options', async () => {
    const ctx = await withMenuModule();
    const created = await post(ctx, `/api/modules/${ctx.module.id}/parameters`, {
      name: 'Clock division',
      component_id: ctx.out1.id,
      value_type: 'enum',
      description: 'How fast OUT 1 runs.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Clock division',
      component_id: ctx.out1.id,
      value_type: 'enum',
      options: [],
    });
    const id = created.body.id;

    // The same name on the same jack is a mis-typed second copy, not a
    // second setting; on a different jack it is the ordinary case.
    expect(
      (
        await post(ctx, `/api/modules/${ctx.module.id}/parameters`, {
          name: 'clock division',
          component_id: ctx.out1.id,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await post(ctx, `/api/modules/${ctx.module.id}/parameters`, {
          name: 'Clock division',
          component_id: ctx.out2.id,
        })
      ).status
    ).toBe(201);

    const option = await post(ctx, `/api/modules/${ctx.module.id}/parameters/${id}/options`, {
      value: '/4',
      description: 'Four times slower',
    });
    expect(option.status).toBe(201);
    expect(
      (
        await post(ctx, `/api/modules/${ctx.module.id}/parameters/${id}/options`, { value: '/4' })
      ).status
    ).toBe(409);

    const edited = await put(ctx, `/api/modules/${ctx.module.id}/parameters/${id}`, {
      component_id: null,
      value_type: 'number',
      value_min: '1',
      value_max: '16',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ component_id: null, value_type: 'number', value_min: '1' });
    expect(edited.body.options.map((o) => o.value)).toEqual(['/4']);

    expect(
      (await put(ctx, `/api/modules/${ctx.module.id}/parameters/${id}`, { value_type: 'colour' }))
        .status
    ).toBe(400);

    expect(
      (
        await request(ctx.app)
          .delete(`/api/modules/${ctx.module.id}/parameters/${id}/options/${option.body.id}`)
          .set('Cookie', ctx.aliceCookie)
      ).status
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .delete(`/api/modules/${ctx.module.id}/parameters/${id}`)
          .set('Cookie', ctx.aliceCookie)
      ).status
    ).toBe(200);
    expect(await ctx.db.models.ModuleParameter.count({ where: { id } })).toBe(0);
  });

  it('serves the menu on the module payload, grouped under the jack it configures', async () => {
    const ctx = await withMenuModule();
    const { body } = await post(ctx, `/api/modules/${ctx.module.id}/parameters`, {
      name: 'Wave',
      component_id: ctx.out2.id,
    });
    await post(ctx, `/api/modules/${ctx.module.id}/parameters/${body.id}/options`, {
      value: 'Square',
    });
    const res = await get(ctx, `/api/modules/${ctx.module.id}`);
    expect(res.status).toBe(200);
    expect(res.body.parameters).toHaveLength(1);
    expect(res.body.parameters[0]).toMatchObject({
      name: 'Wave',
      component_id: ctx.out2.id,
      options: [{ value: 'Square' }],
    });
  });

  it("is nobody else's to correct", async () => {
    const ctx = await withMenuModule();
    const { body } = await post(ctx, `/api/modules/${ctx.module.id}/parameters`, { name: 'Wave' });
    await createUser(ctx.db, { username: 'bob' });
    const bobCookie = await login(ctx.app, 'bob');
    const res = await request(ctx.app)
      .put(`/api/modules/${ctx.module.id}/parameters/${body.id}`)
      .set('Cookie', bobCookie)
      .send({ name: 'Mine now' });
    expect(res.status).toBe(404);
  });

  it('will not read a menu out of a module with no documents', async () => {
    const ctx = await withMenuModule();
    const res = await post(ctx, `/api/modules/${ctx.module.id}/parameters/find`, {});
    expect(res.status).toBe(409);
  });
});

describe('recording a menu setting in a patch', () => {
  async function withPatch() {
    const ctx = await withMenuModule();
    const parameter = await ctx.db.models.ModuleParameter.create({
      module_id: ctx.module.id,
      component_id: ctx.out1.id,
      name: 'Clock division',
      value_type: 'enum',
    });
    await ctx.db.models.ModuleParameterOption.create({
      parameter_id: parameter.id,
      value: '/4',
    });
    const global = await ctx.db.models.ModuleParameter.create({
      module_id: ctx.module.id,
      component_id: null,
      name: 'Tempo',
      value_type: 'number',
    });
    const racks = await ctx.db.models.Rack.findAll({ where: { user_id: ctx.alice.id } });
    const created = await post(ctx, '/api/patches', { rack_id: racks[0].id, name: 'Krell' });
    const detail = await get(ctx, `/api/patches/${created.body.id}`);
    const instance = detail.body.modules.find((m) => m.module_id === ctx.module.id);
    return { ...ctx, parameter, global, patch: detail.body, instance };
  }

  it('takes a value for a jack’s menu setting, which a plain setting refuses', async () => {
    const ctx = await withPatch();
    const path = `/api/patches/${ctx.patch.id}/settings`;

    // The jack itself is patched with cables, not set.
    const refused = await put(ctx, path, {
      patch_module_id: ctx.instance.id,
      component_id: ctx.out1.id,
      value: '/4',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('cables');

    const set = await put(ctx, path, {
      patch_module_id: ctx.instance.id,
      parameter_id: ctx.parameter.id,
      value: '/4',
    });
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({
      component_id: ctx.out1.id,
      component_name: 'OUT 1',
      parameter_id: ctx.parameter.id,
      parameter_name: 'Clock division',
      value: '/4',
    });

    // One jack carries as many of these as its menu has entries, and each is
    // upserted on its own parameter.
    const again = await put(ctx, path, {
      patch_module_id: ctx.instance.id,
      parameter_id: ctx.parameter.id,
      value: 'x2',
    });
    expect(again.status).toBe(200);
    const alsoTempo = await put(ctx, path, {
      patch_module_id: ctx.instance.id,
      parameter_id: ctx.global.id,
      value: '120',
    });
    expect(alsoTempo.status).toBe(201);
    expect(alsoTempo.body.component_name).toBe(null);
    expect(await ctx.db.models.PatchSetting.count()).toBe(2);

    // A parameter of another module is not this instance's to set.
    const other = await insertModule(ctx.db, ctx.alice.id, { manufacturer: 'Doepfer', name: 'A-118' });
    const stray = await ctx.db.models.ModuleParameter.create({
      module_id: other.id,
      name: 'Rate',
    });
    expect(
      (
        await put(ctx, path, {
          patch_module_id: ctx.instance.id,
          parameter_id: stray.id,
          value: '5',
        })
      ).status
    ).toBe(400);
  });

  it('carries the menu and its recorded values on the patch, and into a question', async () => {
    const ctx = await withPatch();
    await put(ctx, `/api/patches/${ctx.patch.id}/settings`, {
      patch_module_id: ctx.instance.id,
      parameter_id: ctx.parameter.id,
      value: '/4',
    });
    const res = await get(ctx, `/api/patches/${ctx.patch.id}`);
    expect(res.status).toBe(200);
    const instance = res.body.modules.find((m) => m.id === ctx.instance.id);
    expect(instance.parameters.map((p) => p.name)).toEqual(['Clock division', 'Tempo']);
    expect(instance.parameters[0].options.map((o) => o.value)).toEqual(['/4']);
    expect(res.body.settings[0]).toMatchObject({
      parameter_name: 'Clock division',
      component_name: 'OUT 1',
      value: '/4',
    });

    // What the LLM is told about the patch says which setting it is: the
    // jack, then the menu entry of it.
    const text = patchTextDocument(res.body);
    expect(text).toContain('"OUT 1" menu setting "Clock division": /4');
  });
});
