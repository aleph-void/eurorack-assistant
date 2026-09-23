import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, fakeBackend } from './helpers.js';
import { createWorker } from '../src/jobs/worker.js';
import { LLM_JOB_TYPES } from '../src/services/llmModels.js';
import {
  DEFAULT_MAX_CABLES,
  GENERATE_TEMPLATE,
  MAX_GENERATED_CABLES,
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
    });
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

  it('is a model job with a per-type model override like the other LLM work', () => {
    expect(LLM_JOB_TYPES).toContain('generate_patch');
  });
});

describe('generate_patch job', () => {
  it('writes the legal cables and settings the model proposed, and nothing else', async () => {
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

    const prompts = [];
    const backend = fakeBackend({
      completeText: (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
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
            // Legal, but the budget is spent after it.
            { from_module: vco, from_jack: fixture.sub.id, to_module: vco, to_jack: fixture.pitch.id, note: 'fm' },
            // Legal on its own, but over the budget.
            { from_module: vcf, from_jack: fixture.filterOut.id, to_module: vco, to_jack: fixture.pitch.id },
          ],
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
        });
      },
    });
    const worker = makeWorker(db, backend);
    const done = await worker.tick();
    expect(done.status).toBe('complete');
    expect(done.error).toBeNull();

    // The prompt carried the brief, the budget and the inventory.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('an acid line');
    expect(prompts[0]).toContain('AT MOST 3 new patch cable(s)');
    expect(prompts[0]).toContain(`## Instance ${vco}: Make Noise STO`);
    expect(prompts[0]).toContain('A compact analog oscillator');
    expect(prompts[0]).toContain(`- jack ${fixture.sine.id} "Sine" — output`);
    expect(prompts[0]).toContain(`- control ${fixture.mode.id} "Mode" — switch — positions: LP | BP | HP`);
    expect(prompts[0]).not.toContain('"Expander"');

    const detail = (
      await request(app).get(`/api/patches/${created.id}`).set('Cookie', aliceCookie)
    ).body;
    expect(detail.generating).toBe(false);
    expect(detail.description).toBe('Sine through the filter to the outs.');
    expect(
      detail.cables.map((c) => [c.from_component_name, c.to_component_name, c.note])
    ).toEqual([
      ['Sine', 'In', 'audio'],
      ['LP', 'Audio In', 'to the speakers'],
      ['Sub', '1V/Oct', 'fm'],
    ]);
    expect(detail.settings.map((s) => [s.component_name, s.value])).toEqual([
      ['Mode', 'LP'],
      ['Cutoff', '4'],
    ]);
    // The patch traces like any other: audio reaches the outs.
    expect(detail.flow.length).toBeGreaterThan(0);
  });

  it('fills up to the limit around cables already there, and stops when it is met', async () => {
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
    const backend = fakeBackend({
      completeText: (prompt) => {
        expect(prompt).toContain('AT MOST 1 new patch cable(s) (1 are already plugged');
        expect(prompt).toContain('Cables already patched');
        return JSON.stringify({
          cables: [
            { from_module: vcf, from_jack: fixture.filterOut.id, to_module: out, to_jack: fixture.audioIn.id },
            { from_module: vco, from_jack: fixture.sub.id, to_module: vco, to_jack: fixture.pitch.id },
          ],
        });
      },
    });
    const worker = makeWorker(db, backend);
    expect((await worker.tick()).status).toBe('complete');
    const { rows: cables } = await db.query(
      'SELECT to_component_name FROM patch_cables WHERE patch_id = $1 ORDER BY id',
      [created.id]
    );
    expect(cables.map((c) => c.to_component_name)).toEqual(['In', 'Audio In']);

    // Asked again with the budget already met, nothing is asked of the model.
    await db.query(
      `INSERT INTO jobs (type, user_id, payload, status) VALUES ('generate_patch', $1, $2, 'pending')`,
      [fixture.alice.id, JSON.stringify({ patch_id: created.id, max_cables: 2 })]
    );
    expect((await worker.tick()).status).toBe('complete');
    expect(backend.calls.completeText).toHaveLength(1);
  });

  it('fails the attempt when the model proposes nothing usable', async () => {
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
    const backend = fakeBackend({
      completeText: JSON.stringify({
        cables: [{ from_module: vco, from_jack: fixture.pitch.id, to_module: vco, to_jack: fixture.sine.id }],
      }),
    });
    const worker = makeWorker(db, backend);
    const failed = await worker.tick();
    // Not permanent: the next attempt gets another answer.
    expect(failed.status).toBe('pending');
    expect(failed.error).toMatch(/none of the 1 cable\(s\) the model proposed was legal/);
    const { rows: cables } = await db.query('SELECT id FROM patch_cables WHERE patch_id = $1', [
      created.id,
    ]);
    expect(cables).toHaveLength(0);
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
