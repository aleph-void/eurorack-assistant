import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, fakeBackend } from './helpers.js';
import { createBus } from '../src/events.js';
import { createWorker } from '../src/jobs/worker.js';
import { LLM_JOB_TYPES } from '../src/services/llmModels.js';
import {
  MAX_TURN_ROUNDS,
  TURN_CHOICES,
  TURN_TEMPLATE,
  readCollaborationPrompt,
} from '../src/services/patchTurn.js';

// Fixture: alice has a rack holding a voice — an oscillator (two outputs, a
// pitch input, a knob), a filter (an input, an output, a cutoff knob) and an
// output module with one audio input — and a patch of it.
async function withVoice() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query('SELECT id, username FROM users ORDER BY id');
  fixture.alice = users.find((u) => u.username === 'alice');
  fixture.vco = await insertModule(db, fixture.alice.id, { manufacturer: 'Make Noise', name: 'STO' });
  fixture.vcf = await insertModule(db, fixture.alice.id, { manufacturer: 'Mutable', name: 'Ripples' });
  fixture.out = await insertModule(db, fixture.alice.id, { manufacturer: 'Intellijel', name: 'Outs' });
  const { rows: components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'output_jack', 'Sine'),
     ($1, 'output_jack', 'Sub'),
     ($1, 'input_jack', '1V/Oct'),
     ($2, 'input_jack', 'In'),
     ($2, 'input_jack', 'FM'),
     ($2, 'output_jack', 'LP'),
     ($2, 'knob', 'Cutoff'),
     ($3, 'input_jack', 'Audio In')
     RETURNING *`,
    [fixture.vco.id, fixture.vcf.id, fixture.out.id]
  );
  const named = (moduleId, name) =>
    components.find((c) => c.module_id === moduleId && c.name === name);
  fixture.sine = named(fixture.vco.id, 'Sine');
  fixture.sub = named(fixture.vco.id, 'Sub');
  fixture.pitch = named(fixture.vco.id, '1V/Oct');
  fixture.filterIn = named(fixture.vcf.id, 'In');
  fixture.filterFm = named(fixture.vcf.id, 'FM');
  fixture.filterOut = named(fixture.vcf.id, 'LP');
  fixture.cutoff = named(fixture.vcf.id, 'Cutoff');
  fixture.audioIn = named(fixture.out.id, 'Audio In');
  const { rows: racks } = await db.query('SELECT id FROM racks WHERE user_id = $1', [
    fixture.alice.id,
  ]);
  fixture.rackId = racks[0].id;
  fixture.patch = (
    await request(fixture.app)
      .post('/api/patches')
      .set('Cookie', fixture.aliceCookie)
      .send({ rack_id: fixture.rackId, name: 'Together' })
  ).body;
  const { rows: instances } = await db.query(
    'SELECT id, module_id FROM patch_modules WHERE patch_id = $1 ORDER BY id',
    [fixture.patch.id]
  );
  const at = new Map(instances.map((r) => [r.module_id, r.id]));
  fixture.vcoAt = at.get(fixture.vco.id);
  fixture.vcfAt = at.get(fixture.vcf.id);
  fixture.outAt = at.get(fixture.out.id);
  fixture.plug = (from, to, extra = {}) =>
    request(fixture.app)
      .post(`/api/patches/${fixture.patch.id}/cables`)
      .set('Cookie', fixture.aliceCookie)
      .send({
        from_patch_module_id: from[0],
        from_component_id: from[1].id,
        to_patch_module_id: to[0],
        to_component_id: to[1].id,
        ...extra,
      });
  fixture.collaborate = (body) =>
    request(fixture.app)
      .put(`/api/patches/${fixture.patch.id}/collaboration`)
      .set('Cookie', fixture.aliceCookie)
      .send(body);
  fixture.detail = async () =>
    (await request(fixture.app).get(`/api/patches/${fixture.patch.id}`).set('Cookie', fixture.aliceCookie)).body;
  fixture.jobs = async () => (await db.query('SELECT * FROM jobs ORDER BY id')).rows;
  return fixture;
}

// A backend that answers each call with the next scripted answer (the last
// one again once they run out), recording every prompt it was given.
function scripted(answers) {
  const prompts = [];
  const backend = fakeBackend({
    completeText: (prompt) => {
      prompts.push(prompt);
      const answer = answers[Math.min(prompts.length - 1, answers.length - 1)];
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  backend.prompts = prompts;
  return backend;
}

function makeWorker(db, backend, bus = null) {
  return createWorker(db, {
    backendFactory: () => backend,
    renderImpl: async () => false,
    log: () => {},
    bus,
  });
}

describe('readCollaborationPrompt', () => {
  it('trims a brief, takes none as null and holds it to the length limit', () => {
    expect(readCollaborationPrompt(undefined)).toEqual({ value: null });
    expect(readCollaborationPrompt(null)).toEqual({ value: null });
    expect(readCollaborationPrompt('  ')).toEqual({ value: null });
    expect(readCollaborationPrompt('  a drone ')).toEqual({ value: 'a drone' });
    expect(readCollaborationPrompt(7).error).toMatch(/text/);
    expect(readCollaborationPrompt('x'.repeat(2001)).error).toMatch(/2000/);
  });
});

describe('TURN_TEMPLATE', () => {
  it('tells the model whose turn it is, what the user just did and what the two are making', () => {
    const prompt = TURN_TEMPLATE('INVENTORY', {
      brief: 'a slow drone',
      move: 'STO "Sine" → Ripples "In"',
      sinks: 1,
    });
    expect(prompt).toContain('taking turns');
    expect(prompt).toContain('a slow drone');
    expect(prompt).toContain('latest move: STO "Sine" → Ripples "In"');
    expect(prompt).toContain('EXACTLY ONE cable');
    expect(prompt).toContain(`up to ${TURN_CHOICES}`);
    expect(prompt).toContain('jacks sound leaves the system at');
    expect(prompt).toContain('never unplug one');
    expect(prompt).toContain('INVENTORY');
    expect(prompt).not.toContain('REFUSED');
  });

  it('shows a second round what was refused and why', () => {
    const prompt = TURN_TEMPLATE('I', {
      round: 2,
      refused: [{ text: 'instance 1 jack 3 → instance 2 jack 5', reason: 'already has a cable in it' }],
    });
    expect(prompt).toContain('No brief was given');
    expect(prompt).toContain('The user has just changed the patch');
    expect(prompt).toContain('round 2');
    expect(prompt).toContain('- instance 1 jack 3 → instance 2 jack 5: already has a cable in it');
  });
});

describe('PUT /api/patches/:id/collaboration', () => {
  it('switches the mode on and off with a brief, kept across the switch', async () => {
    const fixture = await withVoice();
    const { collaborate, detail, adminCookie, app, patch } = fixture;
    expect((await detail()).collaboration).toEqual({ enabled: false, prompt: null });

    const on = await collaborate({ enabled: true, prompt: '  a slow drone ' });
    expect(on.status).toBe(200);
    expect(on.body.collaboration).toEqual({ enabled: true, prompt: 'a slow drone' });
    expect((await detail()).collaboration).toEqual({ enabled: true, prompt: 'a slow drone' });

    // Off keeps the brief; a body naming the prompt changes it.
    expect((await collaborate({ enabled: false })).body.collaboration).toEqual({
      enabled: false,
      prompt: 'a slow drone',
    });
    expect((await collaborate({ prompt: '' })).body.collaboration).toEqual({
      enabled: false,
      prompt: null,
    });

    expect((await collaborate({})).status).toBe(400);
    expect((await collaborate({ enabled: 'yes' })).status).toBe(400);
    expect((await collaborate({ enabled: true, prompt: 'x'.repeat(2001) })).status).toBe(400);
    // Somebody else's patch is not there to collaborate on.
    const theirs = await request(app)
      .put(`/api/patches/${patch.id}/collaboration`)
      .set('Cookie', adminCookie)
      .send({ enabled: true });
    expect(theirs.status).toBe(404);
  });

  it('is a model job with a per-type model override like the other LLM work', () => {
    expect(LLM_JOB_TYPES).toContain('patch_turn');
  });
});

describe('plugging a cable in collaboration mode', () => {
  it('queues the model’s turn, naming the cable it answers, and says the model is at work', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, detail, jobs, patch, vcoAt, vcfAt, sine, filterIn, alice } = fixture;
    // Off: a cable is just a cable.
    const quiet = await plug([vcoAt, sine], [vcfAt, filterIn]);
    expect(quiet.status).toBe(201);
    expect(quiet.body.turn).toBeNull();
    expect(quiet.body.generating).toBe(false);
    expect(await jobs()).toHaveLength(0);
    await request(fixture.app)
      .delete(`/api/patches/${patch.id}/cables/${quiet.body.id}`)
      .set('Cookie', fixture.aliceCookie);

    await collaborate({ enabled: true, prompt: 'an acid line' });
    const res = await plug([vcoAt, sine], [vcfAt, filterIn]);
    expect(res.status).toBe(201);
    expect(res.body.generating).toBe(true);
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(res.body.turn).toEqual({ job_id: queued[0].id });
    expect(queued[0]).toMatchObject({ type: 'patch_turn', user_id: alice.id, status: 'pending' });
    expect(JSON.parse(queued[0].payload)).toEqual({
      patch_id: patch.id,
      patch_name: 'Together',
      prompt: 'an acid line',
      cable_id: res.body.id,
    });
    // The record says so, and the jobs list names the patch.
    expect(await detail()).toMatchObject({ generating: true });
    const jobList = await request(fixture.app).get('/api/jobs').set('Cookie', fixture.aliceCookie);
    expect(jobList.body.jobs[0]).toMatchObject({ type: 'patch_turn', patch_id: patch.id, patch_name: 'Together' });
  });

  it('queues one turn for several cables plugged while it waits, and another once it is running', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, jobs, db, vcoAt, vcfAt, outAt, sine, sub, pitch, filterIn, filterFm, audioIn, filterOut } = fixture;
    await collaborate({ enabled: true });
    const first = await plug([vcoAt, sine], [vcfAt, filterIn]);
    expect(first.body.turn).not.toBeNull();
    // A second move while the turn is still queued: the queued turn will
    // read both cables, so no second job — but the model is still at work.
    const second = await plug([vcoAt, sub], [vcfAt, filterFm]);
    expect(second.body.turn).toBeNull();
    expect(second.body.generating).toBe(true);
    expect(await jobs()).toHaveLength(1);
    // The turn starts running: it read the patch without the next cable, so
    // that one earns a turn of its own.
    await db.query(`UPDATE jobs SET status = 'running'`);
    const third = await plug([vcfAt, filterOut], [outAt, audioIn]);
    expect(third.body.turn).not.toBeNull();
    expect(await jobs()).toHaveLength(2);
    // While the generator is wiring the patch up, the user's cable is not
    // answered separately: that job is about to plug cables of its own.
    await db.query(`UPDATE jobs SET status = 'complete'`);
    await request(fixture.app)
      .post(`/api/patches/${fixture.patch.id}/generate`)
      .set('Cookie', fixture.aliceCookie)
      .send({ max_cables: 8 });
    const fourth = await plug([vcfAt, filterOut], [vcoAt, pitch]);
    expect(fourth.body.turn).toBeNull();
    expect(fourth.body.generating).toBe(true);
    expect(await jobs()).toHaveLength(3);
  });

  it('is refused a generator run while a turn is live, like a second generator run would be', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, vcoAt, vcfAt, sine, filterIn } = fixture;
    await collaborate({ enabled: true });
    await plug([vcoAt, sine], [vcfAt, filterIn]);
    const res = await request(fixture.app)
      .post(`/api/patches/${fixture.patch.id}/generate`)
      .set('Cookie', fixture.aliceCookie)
      .send({ max_cables: 8 });
    expect(res.status).toBe(409);
  });
});

describe('patch_turn job', () => {
  it('plugs the first legal cable the model offers, with the setting it needs, and says so', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, detail, db, vcoAt, vcfAt, outAt, sine, pitch, filterIn, filterOut, cutoff, audioIn } = fixture;
    await collaborate({ enabled: true, prompt: 'an acid line' });
    const move = await plug([vcoAt, sine], [vcfAt, filterIn], { note: 'the voice' });
    const backend = scripted([
      {
        cables: [
          // Illegal: the filter input is the user's cable's.
          { from_module: vcoAt, from_jack: fixture.sub.id, to_module: vcfAt, to_jack: filterIn.id, note: 'sub too' },
          // Illegal: an input is not a source.
          { from_module: vcoAt, from_jack: pitch.id, to_module: outAt, to_jack: audioIn.id },
          // Legal: carry it on to the outs — the move.
          { from_module: vcfAt, from_jack: filterOut.id, to_module: outAt, to_jack: audioIn.id, note: 'so we can hear it' },
          // Legal too, but the turn is one cable.
          { from_module: vcoAt, from_jack: fixture.sub.id, to_module: vcoAt, to_jack: pitch.id },
        ],
        settings: [
          { module: vcfAt, component: cutoff.id, value: '6' },
          // A jack is not a setting.
          { module: vcoAt, component: sine.id, value: '1' },
        ],
      },
    ]);
    const bus = createBus();
    const events = [];
    bus.subscribe((e) => events.push(e));
    const done = await makeWorker(db, backend, bus).tick();
    expect(done.status).toBe('complete');
    expect(done.error).toBeNull();
    // The finished job's event says what the move was: that is the toast.
    expect(events.at(-1)).toMatchObject({
      event: 'completed',
      message: expect.stringMatching(/^plugged .*"LP".*"Audio In".* — so we can hear it \(and set 1 control\(s\) for it\)$/),
    });
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('an acid line');
    expect(backend.prompts[0]).toContain(
      `latest move: Make Noise STO "Sine" (instance ${vcoAt}, jack ${sine.id}) → Mutable Ripples "In" (instance ${vcfAt}, jack ${filterIn.id}) — "the voice"`
    );
    expect(backend.prompts[0]).toContain('Cables already patched');

    const patch = await detail();
    expect(patch.generating).toBe(false);
    expect(patch.cables.map((c) => [c.from_component_name, c.to_component_name, c.note])).toEqual([
      ['Sine', 'In', 'the voice'],
      ['LP', 'Audio In', 'so we can hear it'],
    ]);
    expect(patch.settings.map((s) => [s.component_name, s.value])).toEqual([['Cutoff', '6']]);
    // The user's description and the mode are left as they were.
    expect(patch.description).toBeNull();
    expect(patch.collaboration).toEqual({ enabled: true, prompt: 'an acid line' });
    expect(move.body.id).toBe(patch.cables[0].id);
  });

  it('asks once more when every cable was refused, then gives up on the patch for good', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, db, vcoAt, vcfAt, sine, sub, pitch, filterIn } = fixture;
    await collaborate({ enabled: true });
    await plug([vcoAt, sine], [vcfAt, filterIn]);
    const backend = scripted([
      { cables: [{ from_module: vcoAt, from_jack: sub.id, to_module: vcfAt, to_jack: filterIn.id }] },
      { cables: [{ from_module: vcoAt, from_jack: pitch.id, to_module: vcfAt, to_jack: filterIn.id }] },
    ]);
    const failed = await makeWorker(db, backend).tick();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/none of the 2 cable\(s\) the model proposed was legal/);
    expect(backend.prompts).toHaveLength(MAX_TURN_ROUNDS);
    expect(backend.prompts[1]).toContain('round 2');
    expect(backend.prompts[1]).toContain('already has a cable in it');
    const { rows } = await db.query('SELECT id FROM patch_cables WHERE patch_id = $1', [fixture.patch.id]);
    expect(rows).toHaveLength(1);
  });

  it('takes no turn when the mode was switched off while it waited', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, db, vcoAt, vcfAt, sine, filterIn } = fixture;
    await collaborate({ enabled: true });
    await plug([vcoAt, sine], [vcfAt, filterIn]);
    await collaborate({ enabled: false });
    const backend = scripted([{ cables: [] }]);
    const done = await makeWorker(db, backend).tick();
    expect(done.status).toBe('complete');
    expect(backend.prompts).toHaveLength(0);
    const { rows } = await db.query('SELECT id FROM patch_cables WHERE patch_id = $1', [fixture.patch.id]);
    expect(rows).toHaveLength(1);
  });

  it('gives up for good on a patch that has been deleted', async () => {
    const fixture = await withVoice();
    const { plug, collaborate, db, vcoAt, vcfAt, sine, filterIn } = fixture;
    await collaborate({ enabled: true });
    await plug([vcoAt, sine], [vcfAt, filterIn]);
    await request(fixture.app).delete(`/api/patches/${fixture.patch.id}`).set('Cookie', fixture.aliceCookie);
    const backend = scripted([{ cables: [] }]);
    const failed = await makeWorker(db, backend).tick();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no longer exists/);
    expect(backend.prompts).toHaveLength(0);
  });
});
