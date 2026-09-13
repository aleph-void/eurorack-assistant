import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertModule, login } from './helpers.js';
import {
  CELL_ACTIONS,
  ELEMENT_KINDS,
  mappingKind,
  resolveMappingTarget,
} from '../src/services/compositions.js';

// Alice with a rack of two modules, a patch over it with a bus and a cable,
// and Bob with nothing, who must not be able to see any of it.
async function fixture() {
  const app = await createTestApp();
  const { db } = app;
  const alice = await db.models.User.findOne({ where: { username: 'alice' } });
  const maths = await insertModule(db, alice.id, { manufacturer: 'Make Noise', name: 'Maths' });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'input_jack', 'Signal In'),
     ($1, 'output_jack', 'EOR'),
     ($1, 'knob', 'Rise') RETURNING *`,
    [maths.id]
  );
  const pam = await insertModule(db, alice.id, { manufacturer: 'ALM', name: 'Pam' });
  const { rows: pamJacks } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'Out 1') RETURNING *`,
    [pam.id]
  );
  const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
  const as = (cookie) => ({
    get: (path) => request(app.app).get(path).set('Cookie', cookie),
    post: (path, body) => request(app.app).post(path).set('Cookie', cookie).send(body),
    put: (path, body) => request(app.app).put(path).set('Cookie', cookie).send(body),
    delete: (path) => request(app.app).delete(path).set('Cookie', cookie),
  });
  const me = as(app.aliceCookie);
  const patch = (await me.post('/api/patches', { rack_id: racks[0].id, name: 'Krell' })).body;
  const detail = (await me.get(`/api/patches/${patch.id}`)).body;
  const mathsInstance = detail.modules.find((m) => m.module_name === 'Maths');
  const pamInstance = detail.modules.find((m) => m.module_name === 'Pam');
  const group = (await me.post(`/api/patches/${patch.id}/groups`, { name: 'Drums' })).body;
  const cable = (
    await me.post(`/api/patches/${patch.id}/cables`, {
      from_patch_module_id: pamInstance.id,
      from_component_id: pamJacks[0].id,
      to_patch_module_id: mathsInstance.id,
      to_component_id: components.find((c) => c.name === 'Signal In').id,
    })
  ).body;
  await createUser(db, { username: 'bob' });
  const bob = as(await login(app.app, 'bob'));
  return {
    ...app,
    me,
    bob,
    alice,
    patch,
    mathsInstance,
    pamInstance,
    knob: components.find((c) => c.name === 'Rise'),
    group,
    cable,
  };
}

// A composition with two scenes and two elements.
async function storyboarded(f) {
  const composition = (await f.me.post('/api/compositions', { name: 'Tide', tempo_bpm: 92 })).body;
  const intro = (await f.me.post(`/api/compositions/${composition.id}/scenes`, { name: 'Intro', duration_seconds: 90 })).body;
  const build = (await f.me.post(`/api/compositions/${composition.id}/scenes`, { name: 'Build' })).body;
  const bass = (await f.me.post(`/api/compositions/${composition.id}/elements`, { name: 'Bass', kind: 'voice' })).body;
  const kick = (await f.me.post(`/api/compositions/${composition.id}/elements`, { name: 'Kick', kind: 'rhythm' })).body;
  return { composition, intro, build, bass, kick };
}

describe('compositions', () => {
  it('creates, lists, reads back, renames and deletes a composition', async () => {
    const f = await fixture();
    const created = await f.me.post('/api/compositions', {
      name: '  Tide  ',
      description: 'slow one',
      tempo_bpm: '92',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Tide', description: 'slow one', tempo_bpm: 92 });

    const list = await f.me.get('/api/compositions');
    expect(list.body.total).toBe(1);
    expect(list.body.compositions[0]).toMatchObject({
      name: 'Tide',
      scene_count: 0,
      element_count: 0,
      patch_count: 0,
    });

    const detail = await f.me.get(`/api/compositions/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: 'Tide', scenes: [], elements: [], cells: [], patches: [] });

    const renamed = await f.me.put(`/api/compositions/${created.body.id}`, { name: 'Tides', tempo_bpm: '' });
    expect(renamed.body).toMatchObject({ name: 'Tides', tempo_bpm: null });

    expect((await f.me.delete(`/api/compositions/${created.body.id}`)).status).toBe(200);
    expect((await f.me.get(`/api/compositions/${created.body.id}`)).status).toBe(404);
  });

  it('keeps one composition name per account and refuses a bad tempo', async () => {
    const f = await fixture();
    await f.me.post('/api/compositions', { name: 'Tide' });
    const again = await f.me.post('/api/compositions', { name: 'Tide' });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("'Tide'");
    // Bob may have his own Tide.
    expect((await f.bob.post('/api/compositions', { name: 'Tide' })).status).toBe(201);
    const other = (await f.me.post('/api/compositions', { name: 'Drift' })).body;
    expect((await f.me.put(`/api/compositions/${other.id}`, { name: 'Tide' })).status).toBe(409);
    expect((await f.me.post('/api/compositions', { name: 'Fast', tempo_bpm: 5000 })).status).toBe(400);
    expect((await f.me.post('/api/compositions', { name: '' })).status).toBe(400);
  });

  it('is private to its owner', async () => {
    const f = await fixture();
    const { composition } = await storyboarded(f);
    expect((await f.bob.get(`/api/compositions/${composition.id}`)).status).toBe(404);
    expect((await f.bob.put(`/api/compositions/${composition.id}`, { name: 'x' })).status).toBe(404);
    expect((await f.bob.post(`/api/compositions/${composition.id}/scenes`, { name: 'x' })).status).toBe(404);
    expect((await f.bob.get('/api/compositions')).body.total).toBe(0);
  });
});

describe('the storyboard', () => {
  it('holds scenes and elements in the order they were added, then in the order sent', async () => {
    const f = await fixture();
    const { composition, intro, build, bass, kick } = await storyboarded(f);
    let detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.scenes.map((s) => s.name)).toEqual(['Intro', 'Build']);
    expect(detail.scenes[0].duration_seconds).toBe(90);
    expect(detail.elements.map((e) => e.name)).toEqual(['Bass', 'Kick']);

    const reordered = await f.me.put(`/api/compositions/${composition.id}/scenes/order`, {
      scene_ids: [build.id, intro.id],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((s) => s.name)).toEqual(['Build', 'Intro']);
    await f.me.put(`/api/compositions/${composition.id}/elements/order`, {
      element_ids: [kick.id, bass.id],
    });
    detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.scenes.map((s) => s.name)).toEqual(['Build', 'Intro']);
    expect(detail.elements.map((e) => e.name)).toEqual(['Kick', 'Bass']);

    // An order that leaves a scene out, or names one twice, is refused whole.
    expect((await f.me.put(`/api/compositions/${composition.id}/scenes/order`, { scene_ids: [build.id] })).status).toBe(400);
    expect((await f.me.put(`/api/compositions/${composition.id}/scenes/order`, { scene_ids: [build.id, build.id] })).status).toBe(400);
  });

  it('validates what an element is and refuses an unnamed scene', async () => {
    const f = await fixture();
    const { composition } = await storyboarded(f);
    const bad = await f.me.post(`/api/compositions/${composition.id}/elements`, { name: 'x', kind: 'drum' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(ELEMENT_KINDS.join(', '));
    expect((await f.me.post(`/api/compositions/${composition.id}/scenes`, { name: '  ' })).status).toBe(400);
    expect((await f.me.post(`/api/compositions/${composition.id}/scenes`, { name: 'x', duration_seconds: -1 })).status).toBe(400);
    // Kind defaults to a voice; an edit may change it.
    const el = (await f.me.post(`/api/compositions/${composition.id}/elements`, { name: 'Wash' })).body;
    expect(el.kind).toBe('voice');
    const edited = await f.me.put(`/api/compositions/${composition.id}/elements/${el.id}`, { kind: 'texture', description: 'reverb tail' });
    expect(edited.body).toMatchObject({ kind: 'texture', description: 'reverb tail' });
  });

  it('writes a cell whole, replaces it on a second write, and clears it', async () => {
    const f = await fixture();
    const { composition, intro, build, bass } = await storyboarded(f);
    const cellPath = `/api/compositions/${composition.id}/scenes/${intro.id}/elements/${bass.id}`;
    const first = await f.me.put(cellPath, { action: 'enter', note: 'fade in over 8 bars' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ scene_id: intro.id, element_id: bass.id, action: 'enter', note: 'fade in over 8 bars' });

    const second = await f.me.put(cellPath, { action: 'change' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: first.body.id, action: 'change', note: null });

    const bad = await f.me.put(cellPath, { action: 'solo' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(CELL_ACTIONS.join(', '));

    let detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.cells).toHaveLength(1);

    // Deleting a scene takes its cells with it; the element stays.
    await f.me.put(`/api/compositions/${composition.id}/scenes/${build.id}/elements/${bass.id}`, { action: 'hold' });
    expect((await f.me.delete(`/api/compositions/${composition.id}/scenes/${build.id}`)).status).toBe(200);
    detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.cells).toHaveLength(1);
    expect(detail.elements).toHaveLength(2);

    expect((await f.me.delete(cellPath)).status).toBe(200);
    detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.cells).toEqual([]);
  });
});

describe('mapping a composition onto a patch', () => {
  it('pairs the two once, and only with a patch the user owns', async () => {
    const f = await fixture();
    const { composition } = await storyboarded(f);
    const mapped = await f.me.post(`/api/compositions/${composition.id}/patches`, {
      patch_id: f.patch.id,
      notes: 'the small-case version',
    });
    expect(mapped.status).toBe(201);
    expect(mapped.body).toMatchObject({ patch_id: f.patch.id, patch_name: 'Krell', notes: 'the small-case version' });

    expect((await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: f.patch.id })).status).toBe(409);
    expect((await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: 9999 })).status).toBe(404);
    expect((await f.me.post(`/api/compositions/${composition.id}/patches`, {})).status).toBe(400);
    // Bob's composition cannot be mapped onto Alice's patch.
    const bobs = (await f.bob.post('/api/compositions', { name: 'Mine' })).body;
    expect((await f.bob.post(`/api/compositions/${bobs.id}/patches`, { patch_id: f.patch.id })).status).toBe(404);

    // The pair shows on the composition, and the composition on the patch.
    const detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.patches).toHaveLength(1);
    expect(detail.patches[0]).toMatchObject({ patch_name: 'Krell', mapping_count: 0, element_count: 2 });
    const onPatch = (await f.me.get(`/api/compositions?patch_id=${f.patch.id}`)).body;
    expect(onPatch.compositions).toHaveLength(1);
    expect(onPatch.compositions[0]).toMatchObject({ name: 'Tide', realization_id: mapped.body.id, mapped_element_count: 0 });
    expect((await f.bob.get(`/api/compositions?patch_id=${f.patch.id}`)).status).toBe(404);

    // Unmapping leaves both records standing.
    expect((await f.me.delete(`/api/compositions/${composition.id}/patches/${f.patch.id}`)).status).toBe(200);
    expect((await f.me.get(`/api/compositions/${composition.id}/patches/${f.patch.id}`)).status).toBe(404);
    expect((await f.me.get(`/api/patches/${f.patch.id}`)).status).toBe(200);
  });

  it('binds an element to an instance, a component, a bus or a cable, naming each', async () => {
    const f = await fixture();
    const { composition, bass, kick } = await storyboarded(f);
    await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: f.patch.id });
    const bind = (body) =>
      f.me.post(`/api/compositions/${composition.id}/patches/${f.patch.id}/mappings`, body);

    const asModule = await bind({ element_id: bass.id, patch_module_id: f.mathsInstance.id });
    expect(asModule.status).toBe(201);
    expect(asModule.body).toMatchObject({ kind: 'module', target_label: 'Make Noise Maths', live: true });

    const asComponent = await bind({
      element_id: bass.id,
      patch_module_id: f.mathsInstance.id,
      component_id: f.knob.id,
      note: 'ride it',
    });
    expect(asComponent.status).toBe(201);
    expect(asComponent.body).toMatchObject({ kind: 'component', target_label: 'Make Noise Maths · Rise', note: 'ride it' });

    const asGroup = await bind({ element_id: kick.id, group_id: f.group.id });
    expect(asGroup.body).toMatchObject({ kind: 'group', target_label: 'Drums' });

    const asCable = await bind({ element_id: kick.id, cable_id: f.cable.id });
    expect(asCable.body).toMatchObject({ kind: 'cable', target_label: 'ALM Pam Out 1 → Make Noise Maths Signal In' });

    const realization = (await f.me.get(`/api/compositions/${composition.id}/patches/${f.patch.id}`)).body;
    expect(realization.composition_name).toBe('Tide');
    expect(realization.elements.map((e) => e.name)).toEqual(['Bass', 'Kick']);
    expect(realization.mappings).toHaveLength(4);
    expect(realization.mappings.every((m) => m.live)).toBe(true);
    const detail = (await f.me.get(`/api/compositions/${composition.id}`)).body;
    expect(detail.patches[0]).toMatchObject({ mapping_count: 4, mapped_element_count: 2 });

    // The same binding twice says nothing new.
    expect((await bind({ element_id: bass.id, patch_module_id: f.mathsInstance.id })).status).toBe(409);
  });

  it('refuses a binding that names nothing, two things, or something not in the patch', async () => {
    const f = await fixture();
    const { composition, bass } = await storyboarded(f);
    await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: f.patch.id });
    const bind = (body) =>
      f.me.post(`/api/compositions/${composition.id}/patches/${f.patch.id}/mappings`, body);

    expect((await bind({ element_id: bass.id })).status).toBe(400);
    expect((await bind({ element_id: bass.id, group_id: f.group.id, cable_id: f.cable.id })).status).toBe(400);
    expect((await bind({ element_id: bass.id, component_id: f.knob.id })).status).toBe(400);
    expect((await bind({ element_id: bass.id, patch_module_id: 9999 })).status).toBe(400);
    expect((await bind({ element_id: bass.id, patch_module_id: f.pamInstance.id, component_id: f.knob.id })).status).toBe(400);
    expect((await bind({ element_id: bass.id, group_id: 9999 })).status).toBe(400);
    expect((await bind({ element_id: bass.id, cable_id: 'abc' })).status).toBe(400);
    expect((await bind({ element_id: 9999, group_id: f.group.id })).status).toBe(404);
    // A mapping onto a patch the composition is not on does not exist.
    expect((await bind({ element_id: bass.id, group_id: f.group.id })).status).toBe(201);
    expect((await f.me.post(`/api/compositions/${composition.id}/patches/9999/mappings`, { element_id: bass.id, group_id: f.group.id })).status).toBe(404);
  });

  it('keeps a binding whose target left the patch, marked as no longer live', async () => {
    const f = await fixture();
    const { composition, bass, kick } = await storyboarded(f);
    await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: f.patch.id });
    const base = `/api/compositions/${composition.id}/patches/${f.patch.id}`;
    await f.me.post(`${base}/mappings`, { element_id: kick.id, cable_id: f.cable.id });
    await f.me.post(`${base}/mappings`, { element_id: kick.id, group_id: f.group.id });
    const onInstance = (await f.me.post(`${base}/mappings`, { element_id: bass.id, patch_module_id: f.pamInstance.id })).body;

    await f.me.delete(`/api/patches/${f.patch.id}/cables/${f.cable.id}`);
    await f.me.delete(`/api/patches/${f.patch.id}/groups/${f.group.id}`);
    const realization = (await f.me.get(base)).body;
    const byKind = Object.fromEntries(realization.mappings.map((m) => [m.kind, m]));
    expect(byKind.cable).toMatchObject({ live: false, target_label: 'ALM Pam Out 1 → Make Noise Maths Signal In' });
    expect(byKind.group).toMatchObject({ live: false, target_label: 'Drums' });
    expect(byKind.module.live).toBe(true);

    // A note and the order may change; a wrong target is removed instead.
    const noted = await f.me.put(`${base}/mappings/${onInstance.id}`, { note: 'clock master', position: 3 });
    expect(noted.body).toMatchObject({ note: 'clock master', position: 3 });
    expect((await f.me.delete(`${base}/mappings/${onInstance.id}`)).status).toBe(200);
    expect((await f.me.get(base)).body.mappings).toHaveLength(2);
  });

  it('drops the mappings with the element, and the pair with the patch', async () => {
    const f = await fixture();
    const { composition, bass, kick } = await storyboarded(f);
    await f.me.post(`/api/compositions/${composition.id}/patches`, { patch_id: f.patch.id });
    const base = `/api/compositions/${composition.id}/patches/${f.patch.id}`;
    await f.me.post(`${base}/mappings`, { element_id: bass.id, group_id: f.group.id });
    await f.me.post(`${base}/mappings`, { element_id: kick.id, group_id: f.group.id });

    await f.me.delete(`/api/compositions/${composition.id}/elements/${bass.id}`);
    expect((await f.me.get(base)).body.mappings.map((m) => m.element_id)).toEqual([kick.id]);

    await f.me.delete(`/api/patches/${f.patch.id}`);
    expect((await f.me.get(base)).status).toBe(404);
    expect((await f.me.get(`/api/compositions/${composition.id}`)).body.patches).toEqual([]);
  });
});

describe('resolveMappingTarget', () => {
  it('reads the kind of a row off its columns', () => {
    expect(mappingKind({ patch_module_id: 3, component_id: null, group_id: null, cable_id: null })).toBe('module');
    expect(mappingKind({ patch_module_id: 3, component_id: 7, group_id: null, cable_id: null })).toBe('component');
    expect(mappingKind({ patch_module_id: null, component_id: null, group_id: 2, cable_id: null })).toBe('group');
    expect(mappingKind({ patch_module_id: null, component_id: null, group_id: null, cable_id: 9 })).toBe('cable');
  });

  it('says what is wrong with a request before the database has to', async () => {
    const f = await fixture();
    const patch = await f.db.models.Patch.findOne({ where: { id: f.patch.id } });
    expect((await resolveMappingTarget(f.db, patch, {})).error).toMatch(/patch_module_id/);
    expect((await resolveMappingTarget(f.db, patch, { patch_module_id: 'x' })).error).toMatch(/record id/);
    expect((await resolveMappingTarget(f.db, patch, { component_id: 1 })).error).toMatch(/patch_module_id/);
  });
});
