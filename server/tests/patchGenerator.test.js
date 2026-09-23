import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, fakeBackend } from './helpers.js';
import { createWorker } from '../src/jobs/worker.js';
import { LLM_JOB_TYPES } from '../src/services/llmModels.js';
import {
  DEFAULT_MAX_CABLES,
  GENERATE_TEMPLATE,
  MAX_CABLE_ROUNDS,
  MAX_GENERATED_CABLES,
  REFINE_TEMPLATE,
  SETTINGS_TEMPLATE,
  parseGeneratedPatch,
  patchInventoryDocument,
  readMaxCables,
} from '../src/services/patchGenerator.js';

// Fixture: alice has a rack holding a voice — an oscillator (two outputs, a
// pitch input, a knob), a filter (an input, an output, a cutoff knob with a
// range, a mode switch with positions) and an output module with a MIDI
// socket beside its audio input — plus a module nothing has analyzed.
async function withVoice() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.vco = await insertModule(db, fixture.alice.id, {
    manufacturer: 'Make Noise',
    name: 'STO',
    summary: 'A compact analog oscillator with a sub output.',
  });
  fixture.vcf = await insertModule(db, fixture.alice.id, { manufacturer: 'Mutable', name: 'Ripples' });
  fixture.out = await insertModule(db, fixture.alice.id, { manufacturer: 'Intellijel', name: 'Outs' });
  fixture.blank = await insertModule(db, fixture.alice.id, { manufacturer: 'ALM', name: 'Pam' });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name, port_kind, group_label) VALUES
     ($1, 'output_jack', 'Sine', NULL, NULL),
     ($1, 'output_jack', 'Sub', NULL, NULL),
     ($1, 'input_jack', '1V/Oct', NULL, NULL),
     ($1, 'knob', 'Shape', NULL, NULL),
     ($2, 'input_jack', 'In', NULL, NULL),
     ($2, 'input_jack', 'FM', NULL, NULL),
     ($2, 'output_jack', 'LP', NULL, NULL),
     ($2, 'knob', 'Cutoff', NULL, NULL),
     ($2, 'switch', 'Mode', NULL, NULL),
     ($3, 'input_jack', 'Audio In', NULL, NULL),
     ($3, 'input_jack', 'MIDI In', 'midi_din', NULL),
     ($3, 'input_jack', 'Expander', 'ribbon', NULL)
     RETURNING *`,
    [fixture.vco.id, fixture.vcf.id, fixture.out.id]
  );
  const named = (moduleId, name) =>
    components.find((c) => c.module_id === moduleId && c.name === name);
  fixture.sine = named(fixture.vco.id, 'Sine');
  fixture.sub = named(fixture.vco.id, 'Sub');
  fixture.pitch = named(fixture.vco.id, '1V/Oct');
  fixture.shape = named(fixture.vco.id, 'Shape');
  fixture.filterIn = named(fixture.vcf.id, 'In');
  fixture.filterFm = named(fixture.vcf.id, 'FM');
  fixture.filterOut = named(fixture.vcf.id, 'LP');
  fixture.cutoff = named(fixture.vcf.id, 'Cutoff');
  fixture.mode = named(fixture.vcf.id, 'Mode');
  fixture.audioIn = named(fixture.out.id, 'Audio In');
  fixture.midiIn = named(fixture.out.id, 'MIDI In');
  fixture.ribbon = named(fixture.out.id, 'Expander');
  await db.query(
    `INSERT INTO component_values (component_id, type, value) VALUES
     ($1, 'min', '0'), ($1, 'max', '10'),
     ($2, 'enum', 'LP'), ($2, 'enum', 'BP'), ($2, 'enum', 'HP')`,
    [fixture.cutoff.id, fixture.mode.id]
  );
  const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [
    fixture.alice.id,
  ]);
  fixture.rackId = racks[0].id;
  return fixture;
}

// The instance ids the patch gave each module, by module id.
async function instancesOf(db, patchId) {
  const { rows } = await db.query(
    'SELECT id, module_id FROM patch_modules WHERE patch_id = $1 ORDER BY id',
    [patchId]
  );
  return new Map(rows.map((r) => [r.module_id, r.id]));
}

// A backend that answers each call with the next scripted answer (the last
// one again once they run out), recording every prompt it was given.
function scripted(answers) {
  const prompts = [];
  const backend = fakeBackend({
    completeText: (prompt) => {
      prompts.push(prompt);
      const answer = answers[Math.min(prompts.length - 1, answers.length - 1)];
      if (typeof answer === 'function') return answer(prompt);
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  backend.prompts = prompts;
  return backend;
}

function makeWorker(db, backend) {
  return createWorker(db, {
    backendFactory: () => backend,
    renderImpl: async () => false,
    log: () => {},
  });
}

describe('readMaxCables', () => {
  it('defaults when nothing is asked and holds the rest to a whole number in range', () => {
    expect(readMaxCables(undefined)).toEqual({ value: DEFAULT_MAX_CABLES });
    expect(readMaxCables('')).toEqual({ value: DEFAULT_MAX_CABLES });
    expect(readMaxCables('8')).toEqual({ value: 8 });
    expect(readMaxCables(MAX_GENERATED_CABLES)).toEqual({ value: MAX_GENERATED_CABLES });
    for (const bad of [0, -1, 2.5, 'ten', true, MAX_GENERATED_CABLES + 1]) {
      expect(readMaxCables(bad).error).toMatch(/whole number/);
    }
  });
});

describe('parseGeneratedPatch', () => {
  it('reads the cables and settings the app asked for, flat or nested, and drops the rest', () => {
    const answer = `Here is the patch:
\`\`\`json
{
  "description": "  A bright  lead.  ",
  "cables": [
    { "from_module": 1, "from_jack": 10, "to_module": 2, "to_jack": 20, "note": "audio" },
    { "from": { "module": 1, "jack": 11 }, "to": { "instance": 3, "component": 30 }, "why": "sub" },
    { "from_module": "x", "from_jack": 10, "to_module": 2, "to_jack": 20 },
    { "from_module": 1, "from_jack": 10 }
  ],
  "settings": [
    { "module": 2, "component": 21, "value": "LP" },
    { "module": 2, "parameter": 5, "value": 3 },
    { "module": 2, "component": 21, "value": "" },
    { "module": 2, "value": "x" }
  ]
}
\`\`\``;
    expect(parseGeneratedPatch(answer)).toEqual({
      description: 'A bright lead.',
      cables: [
        { from_module: 1, from_jack: 10, to_module: 2, to_jack: 20, note: 'audio' },
        { from_module: 1, from_jack: 11, to_module: 3, to_jack: 30, note: 'sub' },
      ],
      settings: [
        { module: 2, component: 21, parameter: null, value: 'LP' },
        { module: 2, component: null, parameter: 5, value: '3' },
      ],
      unplug: [],
      done: false,
    });
  });

  it('reads the cables to take back and whether the model is done', () => {
    const parsed = parseGeneratedPatch('{"done": true, "unplug": [4, "x", {"cable": 9}, 4]}');
    expect(parsed).toMatchObject({ done: true, unplug: [4, 9], cables: [], settings: [] });
    expect(parseGeneratedPatch('{"done": "yes"}').done).toBe(false);
  });

  it('keeps a few spares past the limit but not a thousand', () => {
    const cables = Array.from({ length: 100 }, (_, i) => ({
      from_module: 1,
      from_jack: 10 + i,
      to_module: 2,
      to_jack: 200 + i,
    }));
    const parsed = parseGeneratedPatch(JSON.stringify({ cables }), { maxCables: 3 });
    expect(parsed.cables).toHaveLength(3 * 2 + 10);
  });

  it('refuses an answer with no object in it', () => {
    expect(() => parseGeneratedPatch('no patch for you')).toThrow(/JSON object/);
  });
});

describe('patchInventoryDocument', () => {
  const patch = {
    name: 'Krell',
    rack_name: 'main rack',
    modules: [
      {
        id: 1,
        module_id: 100,
        manufacturer: 'Make Noise',
        module_name: 'STO',
        instance: 1,
        rack_name: 'left',
        components: [
          { id: 10, type: 'output_jack', name: 'Sine', voltage_min: -5, voltage_max: 5, polarity: 'bipolar', description: 'the sine wave', values: [] },
          { id: 11, type: 'bidirectional_jack', name: 'Mult A', group_label: 'A', values: [] },
          { id: 12, type: 'input_jack', name: 'USB', port_kind: 'usb', values: [] },
          { id: 13, type: 'input_jack', name: 'MIDI', port_kind: 'midi_din', values: [] },
          { id: 14, type: 'knob', name: 'Cutoff', values: [{ type: 'min', value: '0' }, { type: 'max', value: '10' }] },
          { id: 15, type: 'switch', name: 'Mode', values: [{ type: 'enum', value: 'LP' }, { type: 'enum', value: 'HP' }] },
        ],
        parameters: [
          { id: 7, name: 'Division', component_id: 10, options: [{ value: '/1' }, { value: '/2' }] },
        ],
      },
      {
        id: 2,
        module_id: 200,
        manufacturer: 'Intellijel',
        module_name: 'Outs',
        instance: 2,
        rack_name: 'right',
        components: [{ id: 20, type: 'input_jack', name: 'In', values: [] }],
        parameters: [],
      },
    ],
    cables: [
      {
        from_patch_module_id: 1,
        from_component_id: 10,
        from_component_name: 'Sine',
        to_patch_module_id: 2,
        to_component_id: 20,
        to_component_name: 'In',
      },
    ],
    settings: [
      { patch_module_id: 1, component_id: 15, component_name: 'Mode', parameter_id: null, value: 'HP' },
      { patch_module_id: 1, component_id: 10, component_name: 'Sine', parameter_id: 7, parameter_name: 'Division', value: '/2' },
    ],
  };

  it('names every instance, jack, control and menu setting by id', () => {
    const text = patchInventoryDocument(patch, {
      summaries: new Map([[100, 'An oscillator.']]),
      normalizationLines: ['- Make Noise STO: "Sub" is normalled to the "Sine" output'],
    });
    expect(text).toContain('## Instance 1: Make Noise STO (in rack "left")');
    expect(text).toContain('An oscillator.');
    expect(text).toContain('- jack 10 "Sine" — output [-5 to 5 V, bipolar]: the sine wave');
    expect(text).toContain('- jack 11 "Mult A" — mult (takes a cable in or sends one out) (mult section "A")');
    expect(text).toContain('- jack 13 "MIDI" — input (midi din connection)');
    expect(text).toContain('- control 14 "Cutoff" — knob — range 0 to 10');
    expect(text).toContain('- control 15 "Mode" — switch — positions: LP | HP');
    expect(text).toContain('- parameter 7 "Division" (of jack 10 "Sine") — options: /1 | /2');
    expect(text).toContain('## Instance 2: Intellijel Outs #2 (in rack "right")');
    expect(text).toContain('Cables already patched');
    expect(text).toContain('(instance 1, jack 10) → Intellijel Outs #2 "In" (instance 2, jack 20)');
    expect(text).toContain('Normalled connections');
    expect(text).toContain('"Sub" is normalled to');
    expect(text).toContain('Settings already dialed in');
    expect(text).toContain('(instance 1) control 15 "Mode" = HP');
    expect(text).toContain('(instance 1) parameter 7 "Division" (of "Sine") = /2');
  });

  it('leaves out the connectors a cable cannot reach', () => {
    const text = patchInventoryDocument(patch);
    expect(text).not.toContain('"USB"');
  });

  it('is wrapped in a prompt that states the budget and the brief', () => {
    const prompt = GENERATE_TEMPLATE('INVENTORY', { maxCables: 6, brief: 'a slow drone' });
    expect(prompt).toContain('AT MOST 6 new patch cable(s)');
    expect(prompt).toContain('a slow drone');
    expect(prompt).toContain('INVENTORY');
    const topped = GENERATE_TEMPLATE('I', { maxCables: 6, existingCables: 4 });
    expect(topped).toContain('AT MOST 2 new patch cable(s) (4 are already plugged');
    expect(topped).toContain('No brief was given');
  });

  it('shows a later round what landed, what was refused and why, and the budget left', () => {
    const prompt = REFINE_TEMPLATE('INVENTORY', {
      maxCables: 6,
      brief: 'a drone',
      room: 2,
      round: 2,
      kept: [{ id: 41, text: 'STO "Sine" → Ripples "In"' }],
      refused: [{ text: 'instance 1 jack 3 → instance 2 jack 5', reason: 'already has a cable in it' }],
    });
    expect(prompt).toContain('round 2 of building it');
    expect(prompt).toContain('a drone');
    expect(prompt).toContain('- cable 41: STO "Sine" → Ripples "In"');
    expect(prompt).toContain('- instance 1 jack 3 → instance 2 jack 5: already has a cable in it');
    expect(prompt).toContain('AT MOST 2 more cable(s) (the user\'s limit is 6 in all)');
    expect(prompt).toContain('"unplug"');
    expect(prompt).toContain('INVENTORY');
  });

  it('reviews the settings over the traced patch, not the inventory alone', () => {
    const prompt = SETTINGS_TEMPLATE('INVENTORY', '# Patch: Krell\nTRACED', { brief: 'a drone' });
    expect(prompt).toContain('A patch is more than its connections');
    expect(prompt).toContain('a drone');
    expect(prompt).toContain('TRACED');
    expect(prompt).toContain('INVENTORY');
    expect(prompt).toContain('"settings"');
  });
});

describe('POST /api/patches/generate', () => {
  it('makes the empty patch now and queues the wiring as a job', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const res = await request(app)
      .post('/api/patches/generate')
      .set('Cookie', aliceCookie)
      .send({ rack_id: rackId, name: 'Auto', max_cables: 5, prompt: '  a techno voice ' });
    expect(res.status).toBe(202);
    expect(res.body.name).toBe('Auto');
    expect(res.body.module_count).toBe(4);
    expect(res.body.generating).toBe(true);
    expect(res.body.job_id).toBeTruthy();

    const { rows: jobs } = await db.query('SELECT * FROM jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('generate_patch');
    expect(jobs[0].user_id).toBe(fixture.alice.id);
    expect(JSON.parse(jobs[0].payload)).toEqual({
      patch_id: res.body.id,
      patch_name: 'Auto',
      max_cables: 5,
      prompt: 'a techno voice',
      patch_module_ids: [],
      only_modules: false,
    });

    // The list and the record both say the model is still at it.
    const list = await request(app).get('/api/patches').set('Cookie', aliceCookie);
    expect(list.body.patches[0]).toMatchObject({ id: res.body.id, generating: true });
    const detail = await request(app).get(`/api/patches/${res.body.id}`).set('Cookie', aliceCookie);
    expect(detail.body.generating).toBe(true);
    expect(detail.body.cables).toEqual([]);

    // The jobs list names the patch, as it names a module or a rack.
    const jobList = await request(app).get('/api/jobs').set('Cookie', aliceCookie);
    expect(jobList.body.jobs[0]).toMatchObject({
      type: 'generate_patch',
      patch_id: res.body.id,
      patch_name: 'Auto',
    });
  });

  it('takes a whole system, and the default cable budget when none is given', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const system = (
      await request(app).post('/api/systems').set('Cookie', aliceCookie).send({ name: 'studio' })
    ).body;
    await request(app)
      .put(`/api/racks/${rackId}/system`)
      .set('Cookie', aliceCookie)
      .send({ system_id: system.id });
    const res = await request(app)
      .post('/api/patches/generate')
      .set('Cookie', aliceCookie)
      .send({ system_id: system.id, name: 'Whole studio' });
    expect(res.status).toBe(202);
    expect(res.body.system_id).toBe(system.id);
    const { rows: jobs } = await db.query('SELECT payload FROM jobs');
    expect(JSON.parse(jobs[0].payload)).toMatchObject({
      max_cables: DEFAULT_MAX_CABLES,
      prompt: null,
    });
  });

  it('refuses what it cannot serve before anything is queued', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const post = (body) =>
      request(app).post('/api/patches/generate').set('Cookie', aliceCookie).send(body);
    expect((await post({ rack_id: rackId })).status).toBe(400);
    expect((await post({ rack_id: rackId, name: 'X', max_cables: 0 })).status).toBe(400);
    expect((await post({ rack_id: rackId, name: 'X', max_cables: 'lots' })).status).toBe(400);
    expect((await post({ rack_id: rackId, name: 'X', prompt: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post({ rack_id: 9999, name: 'X' })).status).toBe(404);
    expect((await post({ system_id: 9999, name: 'X' })).status).toBe(404);
    await request(app)
      .post('/api/patches')
      .set('Cookie', aliceCookie)
      .send({ rack_id: rackId, name: 'Taken' });
    const taken = await post({ rack_id: rackId, name: 'Taken' });
    expect(taken.status).toBe(409);
    const { rows: jobs } = await db.query('SELECT id FROM jobs');
    expect(jobs).toHaveLength(0);
  });

  it('runs the generator again on a patch that exists, one job at a time', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId, adminCookie } = fixture;
    const created = (
      await request(app)
        .post('/api/patches')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'By hand' })
    ).body;
    const refine = (cookie, body) =>
      request(app).post(`/api/patches/${created.id}/generate`).set('Cookie', cookie).send(body);
    // Somebody else's patch is not there to be generated.
    expect((await refine(adminCookie, {})).status).toBe(404);
    expect((await refine(aliceCookie, { max_cables: 'many' })).status).toBe(400);
    const res = await refine(aliceCookie, { max_cables: 8, prompt: 'add modulation' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: created.id, generating: true, job_id: expect.any(Number) });
    const { rows: jobs } = await db.query('SELECT payload FROM jobs');
    expect(JSON.parse(jobs[0].payload)).toEqual({
      patch_id: created.id,
      patch_name: 'By hand',
      max_cables: 8,
      prompt: 'add modulation',
      patch_module_ids: [],
      only_modules: false,
    });
    // While that job is live the patch says so, and a second is refused.
    const detail = await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie);
    expect(detail.body.generating).toBe(true);
    const again = await refine(aliceCookie, { prompt: 'more' });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('already being generated');
  });

  it('takes the modules to use, by module for a new patch and by instance for one that exists', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const post = (body) =>
      request(app).post('/api/patches/generate').set('Cookie', aliceCookie).send(body);
    // A module that is not in the rack, a list that is not a list, and
    // instance ids on a patch that has none yet are all refused up front.
    expect((await post({ rack_id: rackId, name: 'X', module_ids: [999999] })).status).toBe(400);
    expect((await post({ rack_id: rackId, name: 'X', module_ids: 'vco' })).status).toBe(400);
    expect((await post({ rack_id: rackId, name: 'X', patch_module_ids: [1] })).status).toBe(400);
    expect((await db.query('SELECT id FROM patches')).rows).toHaveLength(0);

    const res = await post({
      rack_id: rackId,
      name: 'Two of them',
      module_ids: [fixture.vco.id, fixture.vcf.id, fixture.vco.id],
      only_modules: true,
    });
    expect(res.status).toBe(202);
    const at = await instancesOf(db, res.body.id);
    const { rows: jobs } = await db.query('SELECT payload FROM jobs ORDER BY id');
    expect(JSON.parse(jobs[0].payload)).toMatchObject({
      patch_module_ids: [at.get(fixture.vco.id), at.get(fixture.vcf.id)],
      only_modules: true,
    });

    // On a patch that exists, instances are named outright — and `only`
    // with nothing named means nothing.
    const refine = (body) =>
      request(app).post(`/api/patches/${res.body.id}/generate`).set('Cookie', aliceCookie).send(body);
    await db.query(`UPDATE jobs SET status = 'complete'`);
    expect((await refine({ patch_module_ids: [999999] })).status).toBe(400);
    const again = await refine({
      patch_module_ids: [at.get(fixture.out.id)],
      module_ids: [fixture.vco.id],
      only_modules: true,
    });
    expect(again.status).toBe(202);
    const { rows: more } = await db.query('SELECT payload FROM jobs ORDER BY id');
    expect(JSON.parse(more[1].payload)).toMatchObject({
      patch_module_ids: [at.get(fixture.vco.id), at.get(fixture.out.id)],
      only_modules: true,
    });
    await db.query(`UPDATE jobs SET status = 'complete'`);
    const bare = await refine({ only_modules: true });
    expect(bare.status).toBe(202);
    const { rows: last } = await db.query('SELECT payload FROM jobs ORDER BY id');
    expect(JSON.parse(last[2].payload)).toMatchObject({ patch_module_ids: [], only_modules: false });
  });

  it('is a model job with a per-type model override like the other LLM work', () => {
    expect(LLM_JOB_TYPES).toContain('generate_patch');
  });
});

describe('generate_patch job', () => {
  it('writes the legal cables the model proposed, then reviews the settings over the traced patch', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 3, prompt: 'an acid line' })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const out = at.get(fixture.out.id);

    const backend = scripted([
      {
        description: 'Sine through the filter to the outs.',
        cables: [
          // Legal: audio into the filter.
          { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterIn.id, note: 'audio' },
          // Illegal: an input is not a source.
          { from_module: vco, from_jack: fixture.pitch.id, to_module: vcf, to_jack: fixture.filterIn.id },
          // Illegal: the filter input already has a cable in it.
          { from_module: vco, from_jack: fixture.sub.id, to_module: vcf, to_jack: fixture.filterIn.id },
          // Illegal: a MIDI socket does not take a 3.5 mm cable.
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.midiIn.id },
          // Illegal: an expansion header is not a patch point.
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.ribbon.id },
          // Illegal: an invented jack.
          { from_module: vcf, from_jack: 999999, to_module: out, to_jack: fixture.audioIn.id },
          // Legal: the filter to the outs.
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.audioIn.id, note: 'to the speakers' },
          // Legal, and the budget is spent after it.
          { from_module: vco, from_jack: fixture.sub.id, to_module: vco, to_jack: fixture.pitch.id, note: 'fm' },
          // Legal on its own, but over the budget.
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: vco, to_jack: fixture.pitch.id },
        ],
        settings: [{ module: vcf, component: fixture.mode.id, value: 'bp' }],
      },
      // The settings review.
      {
        description: 'Acid: sine into a low-pass, swept.',
        settings: [
          { module: vcf, component: fixture.mode.id, value: 'lp' },
          { module: vcf, component: fixture.cutoff.id, value: '4' },
          // A position the switch does not have.
          { module: vcf, component: fixture.mode.id, value: 'notch' },
          // A jack is not a setting.
          { module: vco, component: fixture.sine.id, value: '1' },
          // Somebody else's instance id.
          { module: 999999, component: fixture.cutoff.id, value: '1' },
        ],
      },
    ]);
    const worker = makeWorker(db, backend);
    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(done.error).toBeNull();

    // The budget was met in the first round, so no second cable round: one
    // ask for cables, one settings review.
    expect(backend.prompts).toHaveLength(2);
    expect(backend.prompts[0]).toContain('an acid line');
    expect(backend.prompts[0]).toContain('AT MOST 3 new patch cable(s)');
    expect(backend.prompts[0]).toContain(`## Instance ${vco}: Make Noise STO`);
    expect(backend.prompts[0]).toContain('A compact analog oscillator');
    expect(backend.prompts[0]).toContain(`- jack ${fixture.sine.id} "Sine" — output`);
    expect(backend.prompts[0]).toContain(`- control ${fixture.mode.id} "Mode" — switch — positions: LP | BP | HP`);
    expect(backend.prompts[0]).not.toContain('"Expander"');
    // The review sees the patch as it stands, traced, and what is set so far.
    expect(backend.prompts[1]).toContain('A patch is more than its connections');
    expect(backend.prompts[1]).toContain('# Patch: Auto');
    expect(backend.prompts[1]).toContain('"Sine"');
    expect(backend.prompts[1]).toContain(`control ${fixture.mode.id} "Mode" = BP`);

    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.generating).toBe(false);
    // The review's account of the patch is the last word.
    expect(detail.description).toBe('Acid: sine into a low-pass, swept.');
    expect(
      detail.cables.map((c) => [c.from_component_name, c.to_component_name, c.note])
    ).toEqual([
      ['Sine', 'In', 'audio'],
      ['LP', 'Audio In', 'to the speakers'],
      ['Sub', '1V/Oct', 'fm'],
    ]);
    // The round-one setting was replaced by the review's.
    expect(detail.settings.map((s) => [s.component_name, s.value])).toEqual([
      ['Mode', 'LP'],
      ['Cutoff', '4'],
    ]);
    // The patch traces like any other: audio reaches the outs.
    expect(detail.flow.length).toBeGreaterThan(0);
  });

  it('goes another round after a refusal, showing what landed and letting the model re-route', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 4 })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const out = at.get(fixture.out.id);

    let firstRoundIds = null;
    const backend = scripted([
      // Round 1: two land, one is refused (the filter input taken twice).
      {
        cables: [
          { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterIn.id, note: 'audio' },
          { from_module: vco, from_jack: fixture.sub.id, to_module: vcf, to_jack: fixture.filterIn.id, note: 'sub too' },
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.audioIn.id, note: 'out' },
        ],
      },
      // Round 2: take back the sine, put the sub in its place and the sine
      // onto the FM input — a re-route around the refusal.
      (prompt) => {
        firstRoundIds = [...prompt.matchAll(/- cable (\d+): /g)].map((m) => Number(m[1]));
        return JSON.stringify({
          unplug: [firstRoundIds[0], 999999],
          cables: [
            { from_module: vco, from_jack: fixture.sub.id, to_module: vcf, to_jack: fixture.filterIn.id, note: 'sub instead' },
            { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterFm.id, note: 'sine as fm' },
          ],
          done: true,
        });
      },
      // The settings review.
      { settings: [{ module: vcf, component: fixture.cutoff.id, value: '7' }] },
    ]);
    const worker = makeWorker(db, backend);
    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(backend.prompts).toHaveLength(3);
    expect(backend.prompts[1]).toContain('round 2 of building it');
    expect(backend.prompts[1]).toContain('AT MOST 2 more cable(s)');
    expect(backend.prompts[1]).toContain('already has a cable in it');
    expect(backend.prompts[1]).toContain(`Make Noise STO "Sine" (instance ${vco}, jack ${fixture.sine.id}) → Mutable Ripples "In"`);
    expect(firstRoundIds).toHaveLength(2);

    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.cables.map((c) => [c.from_component_name, c.to_component_name, c.note])).toEqual([
      ['LP', 'Audio In', 'out'],
      ['Sub', 'In', 'sub instead'],
      ['Sine', 'FM', 'sine as fm'],
    ]);
    expect(detail.settings.map((s) => [s.component_name, s.value])).toEqual([['Cutoff', '7']]);
  });

  it('fills up to the limit around cables already there, and only reviews settings once it is met', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 2 })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const out = at.get(fixture.out.id);
    // The user plugs one cable while the job waits on the queue.
    await request(app)
      .post(`/api/patches/${created.id}/cables`)
      .set('Cookie', aliceCookie)
      .send({
        from_patch_module_id: vco,
        from_component_id: fixture.sine.id,
        to_patch_module_id: vcf,
        to_component_id: fixture.filterIn.id,
      });
    const backend = scripted([
      {
        cables: [
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.audioIn.id },
          { from_module: vco, from_jack: fixture.sub.id, to_module: vco, to_jack: fixture.pitch.id },
        ],
        // The user's own cable is not the model's to take back.
        unplug: [],
      },
      { settings: [] },
    ]);
    const worker = makeWorker(db, backend);
    expect((await worker.tick()).status).toBe('complete');
    expect(backend.prompts[0]).toContain('AT MOST 1 new patch cable(s) (1 are already plugged');
    expect(backend.prompts[0]).toContain('Cables already patched');
    const { rows: cables } = await db.query(
      'SELECT to_component_name FROM patch_cables WHERE patch_id = $1 ORDER BY id',
      [created.id]
    );
    expect(cables.map((c) => c.to_component_name)).toEqual(['In', 'Audio In']);
    expect(backend.prompts).toHaveLength(2);

    // Asked again with the budget already met, only the settings are reviewed.
    await request(app)
      .post(`/api/patches/${created.id}/generate`)
      .set('Cookie', aliceCookie)
      .send({ max_cables: 2, prompt: 'make it brighter' });
    const again = scripted([{ settings: [{ module: vcf, component: fixture.cutoff.id, value: '9' }] }]);
    expect((await makeWorker(db, again).tick()).status).toBe('complete');
    expect(again.prompts).toHaveLength(1);
    expect(again.prompts[0]).toContain('A patch is more than its connections');
    expect(again.prompts[0]).toContain('make it brighter');
    const { rows: settings } = await db.query(
      'SELECT component_name, value FROM patch_settings WHERE patch_id = $1',
      [created.id]
    );
    expect(settings).toEqual([{ component_name: 'Cutoff', value: '9' }]);
  });

  it('fails the attempt when no round produces a usable cable', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto' })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const backend = scripted([
      {
        cables: [{ from_module: vco, from_jack: fixture.pitch.id, to_module: vco, to_jack: fixture.sine.id }],
      },
    ]);
    const worker = makeWorker(db, backend);
    const failed = await worker.tick();
    // Not permanent: the next attempt gets another answer.
    expect(failed.status).toBe('pending');
    expect(failed.error).toMatch(new RegExp(`none of the ${MAX_CABLE_ROUNDS} cable\\(s\\) the model proposed was legal`));
    // Every round was tried, and no settings review followed nothing.
    expect(backend.prompts).toHaveLength(MAX_CABLE_ROUNDS);
    const { rows: cables } = await db.query('SELECT id FROM patch_cables WHERE patch_id = $1', [
      created.id,
    ]);
    expect(cables).toHaveLength(0);
  });

  it('builds towards the marked outputs, and spends a round on reaching one when nothing does', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    await request(app)
      .post(`/api/racks/${rackId}/outputs`)
      .set('Cookie', aliceCookie)
      .send({ module_id: fixture.out.id, component_ids: [fixture.audioIn.id] });
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 4 })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const out = at.get(fixture.out.id);
    const backend = scripted([
      // Round 1: a voice that dead-ends in the filter, nothing refused.
      {
        cables: [
          { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterIn.id, note: 'audio' },
        ],
      },
      // The output round: get it to the outs.
      {
        cables: [
          { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.audioIn.id, note: 'out' },
        ],
      },
      { settings: [] },
    ]);
    const done = await makeWorker(db, backend).tick();
    expect(done.status).toBe('complete');
    expect(backend.prompts).toHaveLength(3);
    expect(backend.prompts[0]).toContain('Design BACKWARDS from them');
    expect(backend.prompts[0]).toContain(
      `## Where sound leaves the system (build towards these)\n- Intellijel Outs "Audio In" (instance ${out}, jack ${fixture.audioIn.id})`
    );
    // No refusal, so the second round is about the output alone.
    expect(backend.prompts[1]).toContain('reaches NONE of the jacks sound leaves the system at');
    expect(backend.prompts[1]).toContain(`Intellijel Outs "Audio In" (instance ${out}, jack ${fixture.audioIn.id})`);
    expect(backend.prompts[2]).toContain('Start from the output chain');
    expect(backend.prompts[2]).toContain('signal reaches it');

    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.cables.map((c) => c.to_component_name)).toEqual(['In', 'Audio In']);
    expect(detail.outputs).toEqual([
      expect.objectContaining({ patch_module_id: out, component_name: 'Audio In', reached: true, live: true }),
    ]);
  });

  it('says so, once, when the output cannot be reached within the budget', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    await request(app)
      .post(`/api/racks/${rackId}/outputs`)
      .set('Cookie', aliceCookie)
      .send({ module_id: fixture.out.id, component_ids: [fixture.audioIn.id] });
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 1 })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const backend = scripted([
      {
        cables: [
          { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterIn.id },
        ],
      },
      { settings: [] },
    ]);
    const done = await makeWorker(db, backend).tick();
    expect(done.status).toBe('complete');
    // The budget is spent, so no round about the output — the job says so
    // instead of asking for cables it cannot keep.
    expect(backend.prompts).toHaveLength(2);
    const { rows: jobs } = await db.query('SELECT payload FROM jobs');
    expect(jobs).toHaveLength(1);
    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.outputs[0].reached).toBe(false);
  });

  it('offers only the chosen modules (and the outputs) under only_modules, and refuses the rest', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    await request(app)
      .post(`/api/racks/${rackId}/outputs`)
      .set('Cookie', aliceCookie)
      .send({ module_id: fixture.out.id, component_ids: [fixture.audioIn.id] });
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', max_cables: 4, module_ids: [fixture.vco.id], only_modules: true })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const out = at.get(fixture.out.id);
    const backend = scripted([
      {
        cables: [
          // Straight to the outs: allowed.
          { from_module: vco, from_jack: fixture.sine.id, to_module: out, to_jack: fixture.audioIn.id },
          // Through the filter: the filter was not chosen.
          { from_module: vco, from_jack: fixture.sub.id, to_module: vcf, to_jack: fixture.filterIn.id },
        ],
        settings: [{ module: vcf, component: fixture.cutoff.id, value: '3' }],
      },
      { done: true },
      { settings: [{ module: vco, component: fixture.shape.id, value: '5' }] },
    ]);
    const done = await makeWorker(db, backend).tick();
    expect(done.status).toBe('complete');
    expect(backend.prompts[0]).toContain('ONLY those be used');
    expect(backend.prompts[0]).toContain(`## Instance ${vco}: Make Noise STO (REQUESTED by the user)`);
    expect(backend.prompts[0]).toContain(`## Instance ${out}: Intellijel Outs`);
    expect(backend.prompts[0]).not.toContain('Mutable Ripples');
    expect(backend.prompts[0]).toContain('2 module instance(s) offered (of 4 in the case)');
    // The refusal names the module, and earns the usual second round.
    expect(backend.prompts[1]).toContain('Mutable Ripples is not one of the modules the user chose');
    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.cables.map((c) => [c.from_component_name, c.to_component_name])).toEqual([
      ['Sine', 'Audio In'],
    ]);
    expect(detail.settings.map((s) => [s.component_name, s.value])).toEqual([['Shape', '5']]);
  });

  it('asks for the chosen modules to take part when they are a request rather than a limit', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto', module_ids: [fixture.vcf.id] })
    ).body;
    const at = await instancesOf(db, created.id);
    const vco = at.get(fixture.vco.id);
    const vcf = at.get(fixture.vcf.id);
    const backend = scripted([
      {
        cables: [
          { from_module: vco, from_jack: fixture.sine.id, to_module: vcf, to_jack: fixture.filterIn.id },
        ],
      },
      { settings: [] },
    ]);
    expect((await makeWorker(db, backend).tick()).status).toBe('complete');
    expect(backend.prompts[0]).toContain('make sure each of them does something in the patch');
    expect(backend.prompts[0]).toContain('## The user asked for these modules to take part');
    expect(backend.prompts[0]).toContain(`## Instance ${vcf}: Mutable Ripples (REQUESTED by the user)`);
    expect(backend.prompts[0]).toContain('## Instance ' + vco + ': Make Noise STO\n');
    expect(backend.prompts[0]).toContain('4 module instance(s). Ids are what');
  });

  it('gives up for good on a patch that has been deleted', async () => {
    const fixture = await withVoice();
    const { app, db, aliceCookie, rackId } = fixture;
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: rackId, name: 'Auto' })
    ).body;
    await request(app).delete(`/api/patches/${created.id}`).set('Cookie', aliceCookie);
    const backend = fakeBackend({ completeText: '{}' });
    const failed = await makeWorker(db, backend).tick();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer exists/);
    expect(backend.calls.completeText).toHaveLength(0);
  });

  it('will not ask about a patch whose modules have no analyzed jacks', async () => {
    const fixture = await createTestApp();
    const { app, db, aliceCookie } = fixture;
    const { rows: users } = await db.query(`SELECT id FROM users WHERE username = 'alice'`);
    await insertModule(db, users[0].id, { manufacturer: 'ALM', name: 'Pam' });
    const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [users[0].id]);
    const created = (
      await request(app)
        .post('/api/patches/generate')
        .set('Cookie', aliceCookie)
        .send({ rack_id: racks[0].id, name: 'Auto' })
    ).body;
    expect(created.id).toBeTruthy();
    const backend = fakeBackend({ completeText: '{}' });
    const failed = await makeWorker(db, backend).tick();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/analyze their manuals first/);
    expect(backend.calls.completeText).toHaveLength(0);
  });
});
