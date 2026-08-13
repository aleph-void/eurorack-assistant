import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  insertManualText,
  insertModule,
  mapModule,
  PDF_BYTES,
  PDF_HASH,
} from './helpers.js';

// The shared manuals of two modules, plus a document alice attached to hers.
const MATHS_MANUAL = [
  '# Make Noise Maths',
  '',
  '## PANEL CONTROLS',
  '',
  'Each channel has an attenuverter, so the signal can be attenuated or',
  'inverted before it reaches the summing bus. The attenuverter is unity at',
  'full clockwise.',
  '',
].join('\n');

const RENE_MANUAL = [
  '# Make Noise Rene',
  '',
  '## THE CARTESIAN SEQUENCER',
  '',
  'Rene is a cartesian sequencer with a quantizer on each axis.',
  '',
].join('\n');

const ALICE_CHEATSHEET = [
  '# Make Noise Maths — cheat sheet',
  '',
  'My own notes: the attenuverter trick for self-oscillating drones, plus a',
  'reminder about the confabulated bus board wiring.',
  '',
].join('\n');

let ctx;
let alice;
let bob;
let maths;
let rene;
let cheatsheet;

beforeEach(async () => {
  ctx = await createTestApp();
  alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
  bob = await ctx.db.models.User.create({
    username: 'bob',
    password_hash: 'x',
    is_admin: false,
  });
  ctx.bobCookie = null;

  maths = await insertModule(ctx.db, alice.id, {
    name: 'Maths',
    manual_hash: PDF_HASH,
    manual_text: MATHS_MANUAL,
  });
  rene = await insertModule(ctx.db, alice.id, {
    name: 'Rene',
    manual_hash: 'b'.repeat(64),
    manual_text: RENE_MANUAL,
  });
  // Both modules are shared records; bob has them racked too.
  await mapModule(ctx.db, bob.id, maths.id);
  await mapModule(ctx.db, bob.id, rene.id);

  const upload = await ctx.db.models.Manual.create({
    module_id: maths.id,
    user_id: alice.id,
    hash: 'c'.repeat(64),
    name: 'cheat sheet',
    original_name: 'maths-cheatsheet.pdf',
    source: 'upload',
  });
  cheatsheet = await insertManualText(ctx.db, upload.get({ plain: true }), {
    title: 'Make Noise Maths — cheat sheet',
    content: ALICE_CHEATSHEET,
  });
});

// bob logs in on demand (createTestApp only makes admin and alice).
async function bobCookie() {
  if (!ctx.bobCookie) {
    await ctx.db.models.User.update(
      { password_hash: (await import('../src/auth.js')).hashPassword('password123') },
      { where: { id: bob.id } }
    );
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'bob', password: 'password123' });
    ctx.bobCookie = res.headers['set-cookie'][0].split(';')[0];
  }
  return ctx.bobCookie;
}

const search = (cookie, query) =>
  request(ctx.app).get(`/api/manuals/search?${query}`).set('Cookie', cookie);

describe('manual search', () => {
  it('finds a word in the manuals and says which module it was in', async () => {
    const res = await search(ctx.aliceCookie, 'q=cartesian');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('cartesian');
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      module_id: rene.id,
      manufacturer: 'Make Noise',
      module_name: 'Rene',
      user_id: null,
      title: 'Make Noise Rene',
    });
    expect(res.body.results[0].hash).toBe('b'.repeat(64));
  });

  it('marks the matched words in the snippet', async () => {
    const res = await search(ctx.aliceCookie, 'q=quantizer');
    expect(res.body.results[0].snippet).toContain('[[quantizer]]');
  });

  it('searches the uploads of the user who attached them, and no one else', async () => {
    // alice sees the shared manual AND her own document.
    const mine = await search(ctx.aliceCookie, 'q=attenuverter');
    expect(mine.body.results.map((r) => r.manual_id).sort()).toEqual(
      [cheatsheet.manual_id, ...mine.body.results.map((r) => r.manual_id)]
        .filter((id, i, all) => all.indexOf(id) === i)
        .sort()
    );
    expect(mine.body.results).toHaveLength(2);
    expect(mine.body.results.some((r) => r.user_id === alice.id)).toBe(true);

    // bob has the same module racked, so he sees its shared manual — but
    // alice's document is hers alone.
    const theirs = await search(await bobCookie(), 'q=attenuverter');
    expect(theirs.body.results).toHaveLength(1);
    expect(theirs.body.results[0].user_id).toBeNull();

    // A word that only appears in alice's document finds nothing for bob.
    const secret = await search(await bobCookie(), 'q=confabulated');
    expect(secret.body.results).toEqual([]);
    const owner = await search(ctx.aliceCookie, 'q=confabulated');
    expect(owner.body.results).toHaveLength(1);
    expect(owner.body.results[0].name).toBe('cheat sheet');
  });

  it('narrows to one module when asked', async () => {
    const res = await search(ctx.aliceCookie, `q=attenuverter&module_id=${rene.id}`);
    expect(res.body.results).toEqual([]);
    const hit = await search(ctx.aliceCookie, `q=attenuverter&module_id=${maths.id}`);
    expect(hit.body.results).toHaveLength(2);
  });

  it('finds a module by its name, since the text is titled with it', async () => {
    const res = await search(ctx.aliceCookie, 'q=rene');
    expect(res.body.results.map((r) => r.module_id)).toContain(rene.id);
  });

  it('ranks and pages the hits', async () => {
    const first = await search(ctx.aliceCookie, 'q=attenuverter&limit=1');
    expect(first.body.results).toHaveLength(1);
    expect(first.body.has_more).toBe(true);
    // The manual that says the word three times outranks the one that says it
    // once, so it is the one on the first page.
    expect(first.body.results[0].manual_id).not.toBe(cheatsheet.manual_id);
    expect(first.body.results[0].rank).toBeGreaterThan(0);

    const second = await search(ctx.aliceCookie, 'q=attenuverter&limit=1&offset=1');
    expect(second.body.results).toHaveLength(1);
    expect(second.body.has_more).toBe(false);
    expect(second.body.results[0].manual_id).toBe(cheatsheet.manual_id);
  });

  it('requires something to search for', async () => {
    const res = await search(ctx.aliceCookie, 'q=%20%20');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q is required/);
  });

  it('is closed to anyone not logged in', async () => {
    const res = await request(ctx.app).get('/api/manuals/search?q=attenuverter');
    expect(res.status).toBe(401);
  });
});

describe('reading a manual as text', () => {
  it('serves the markdown of a shared manual to any user', async () => {
    const res = await request(ctx.app)
      .get(`/api/manuals/${PDF_HASH}/text`)
      .set('Cookie', await bobCookie());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hash: PDF_HASH,
      module_id: maths.id,
      manufacturer: 'Make Noise',
      module_name: 'Maths',
      title: 'Make Noise Maths',
      source: 'pdftotext',
    });
    expect(res.body.content).toContain('## PANEL CONTROLS');
  });

  it('keeps an upload\'s text to its owner', async () => {
    const hash = 'c'.repeat(64);
    const mine = await request(ctx.app)
      .get(`/api/manuals/${hash}/text`)
      .set('Cookie', ctx.aliceCookie);
    expect(mine.status).toBe(200);
    expect(mine.body.content).toContain('confabulated');

    const theirs = await request(ctx.app)
      .get(`/api/manuals/${hash}/text`)
      .set('Cookie', await bobCookie());
    expect(theirs.status).toBe(404);
  });

  it('404s for a hash with no extracted text, and for nonsense', async () => {
    const noText = await insertModule(ctx.db, alice.id, {
      name: 'Wogglebug',
      manual_hash: 'd'.repeat(64),
    });
    expect(noText.id).toBeTruthy();
    const res = await request(ctx.app)
      .get(`/api/manuals/${'d'.repeat(64)}/text`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(404);

    const junk = await request(ctx.app)
      .get('/api/manuals/not-a-hash/text')
      .set('Cookie', ctx.aliceCookie);
    expect(junk.status).toBe(404);
  });

  it('downloads the markdown as a file named after the module', async () => {
    const res = await request(ctx.app)
      .get(`/api/manuals/${PDF_HASH}/text/export`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['content-disposition']).toContain('Make_Noise_Maths_Manual.md');
    expect(res.text).toContain('# Make Noise Maths');
  });
});

describe('a module\'s documents', () => {
  it('says which documents have text to read', async () => {
    const res = await request(ctx.app)
      .get(`/api/modules/${maths.id}`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    const shared = res.body.manuals.find((m) => m.user_id === null);
    expect(shared).toMatchObject({ has_text: true, text_pages: 1 });
    expect(shared.text_chars).toBeGreaterThan(0);

    const noText = await insertModule(ctx.db, alice.id, {
      name: 'Wogglebug',
      manual_hash: 'd'.repeat(64),
    });
    const other = await request(ctx.app)
      .get(`/api/modules/${noText.id}`)
      .set('Cookie', ctx.aliceCookie);
    expect(other.body.manuals[0]).toMatchObject({ has_text: false, text_pages: null });
  });

  it('queues the extraction of a document a user uploads', async () => {
    const res = await request(ctx.app)
      .post(`/api/modules/${maths.id}/manuals`)
      .set('Cookie', ctx.aliceCookie)
      .send({
        name: 'service notes',
        filename: 'service.pdf',
        data_base64: PDF_BYTES.toString('base64'),
      });
    expect(res.status).toBe(201);
    expect(res.body.has_text).toBe(false);
    expect(res.body.job_id).toBeTruthy();

    const job = await ctx.db.models.Job.findByPk(res.body.job_id);
    expect(job.type).toBe('extract_manual');
    expect(job.module_id).toBe(maths.id);
    // The job names the document, since a module has more than one.
    expect(JSON.parse(job.payload)).toEqual({ manual_id: res.body.id });
    // And it belongs to the user who uploaded it, like every other job.
    expect(job.user_id).toBe(alice.id);
  });

  it('does not queue the extraction twice for the same document', async () => {
    const upload = {
      name: 'service notes',
      filename: 'service.pdf',
      data_base64: PDF_BYTES.toString('base64'),
    };
    await request(ctx.app)
      .post(`/api/modules/${maths.id}/manuals`)
      .set('Cookie', ctx.aliceCookie)
      .send(upload);
    const again = await request(ctx.app)
      .post(`/api/modules/${maths.id}/manuals`)
      .set('Cookie', ctx.aliceCookie)
      .send(upload);
    expect(again.status).toBe(200);
    expect(again.body.job_id).toBeNull();
    expect(await ctx.db.models.Job.count({ where: { type: 'extract_manual' } })).toBe(1);
  });

  it('takes the text with the document when it is removed', async () => {
    const upload = await ctx.db.models.Manual.findOne({
      where: { module_id: maths.id, user_id: alice.id },
    });
    await request(ctx.app)
      .delete(`/api/modules/${maths.id}/manuals/${upload.id}`)
      .set('Cookie', ctx.aliceCookie)
      .expect(200);
    expect(await ctx.db.models.ManualDocument.count({ where: { manual_id: upload.id } })).toBe(0);
  });
});
