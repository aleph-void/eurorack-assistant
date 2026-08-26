import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertModule, login, mapModule } from './helpers.js';
import { normalizeUrl, titleFromUrl } from '../src/services/resourceLinks.js';

async function fixture() {
  const app = await createTestApp();
  const alice = await app.db.models.User.findOne({ where: { username: 'alice' } });
  const module = await insertModule(app.db, alice.id);
  const { rows: racks } = await app.db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
  const patch = await request(app.app)
    .post('/api/patches')
    .set('Cookie', app.aliceCookie)
    .send({ rack_id: racks[0].id, name: 'Krell' });
  const system = await request(app.app)
    .post('/api/systems')
    .set('Cookie', app.aliceCookie)
    .send({ name: 'Studio' });
  return {
    ...app,
    alice,
    module,
    rackId: racks[0].id,
    patchId: patch.body.id,
    systemId: system.body.id,
  };
}

const post = (f, body) =>
  request(f.app).post('/api/links').set('Cookie', f.aliceCookie).send(body);

describe('normalizeUrl', () => {
  it('assumes https for a pasted host', () => {
    expect(normalizeUrl('modwiggler.com/forum/x').url).toBe('https://modwiggler.com/forum/x');
    expect(normalizeUrl('  http://example.org/a  ').url).toBe('http://example.org/a');
  });

  // A stored javascript: URL is a stored cross-site script waiting for a
  // renderer that forgets to check.
  it('refuses every scheme that is not http or https', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.org/x',
    ]) {
      expect(normalizeUrl(bad).error).toBeTruthy();
    }
  });

  it('refuses nothing at all and something that is not a URL', () => {
    expect(normalizeUrl('  ').error).toBeTruthy();
    expect(normalizeUrl('http://').error).toBeTruthy();
    expect(normalizeUrl(`https://x.example/${'a'.repeat(2100)}`).error).toBeTruthy();
  });

  it('names a link after its host when the user typed no title', () => {
    expect(titleFromUrl('https://www.modwiggler.com/forum/t?p=1')).toBe('modwiggler.com');
  });
});

describe('/api/links', () => {
  it('hangs a link off each of the four kinds of record', async () => {
    const f = await fixture();
    for (const owner of [
      { module_id: f.module.id },
      { patch_id: f.patchId },
      { rack_id: f.rackId },
      { system_id: f.systemId },
    ]) {
      const res = await post(f, { ...owner, url: 'example.org/thread' });
      expect(res.status).toBe(201);
      expect(res.body.url).toBe('https://example.org/thread');
      expect(res.body.title).toBe('example.org');

      const [key] = Object.keys(owner);
      const list = await request(f.app)
        .get(`/api/links?${key}=${owner[key]}`)
        .set('Cookie', f.aliceCookie);
      expect(list.body).toHaveLength(1);
      expect(list.body[0][key]).toBe(owner[key]);
    }
  });

  it('keeps the order links were added in, and lets it be changed', async () => {
    const f = await fixture();
    const first = await post(f, { module_id: f.module.id, url: 'a.example', title: 'A' });
    const second = await post(f, { module_id: f.module.id, url: 'b.example', title: 'B' });
    expect(first.body.position).toBe(0);
    expect(second.body.position).toBe(1);

    const bad = await request(f.app)
      .put(`/api/links/${second.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ position: -1 });
    expect(bad.status).toBe(400);

    // Reordering is the client sending both positions: the order is the
    // user's, and a link never moves because another one did.
    await request(f.app)
      .put(`/api/links/${second.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ position: 0 });
    await request(f.app)
      .put(`/api/links/${first.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ position: 1 });
    const list = await request(f.app)
      .get(`/api/links?module_id=${f.module.id}`)
      .set('Cookie', f.aliceCookie);
    expect(list.body.map((l) => l.title)).toEqual(['B', 'A']);
  });

  it('needs exactly one owner', async () => {
    const f = await fixture();
    expect((await post(f, { url: 'a.example' })).status).toBe(400);
    expect(
      (await post(f, { module_id: f.module.id, rack_id: f.rackId, url: 'a.example' })).status
    ).toBe(400);
  });

  it('refuses a record that is not this user s', async () => {
    const f = await fixture();
    await createUser(f.db, { username: 'bob' });
    const bobCookie = await login(f.app, 'bob');
    const res = await request(f.app)
      .post('/api/links')
      .set('Cookie', bobCookie)
      .send({ patch_id: f.patchId, url: 'a.example' });
    expect(res.status).toBe(404);

    // A module is shared between everyone who racked it — but bob has not.
    const onModule = await request(f.app)
      .post('/api/links')
      .set('Cookie', bobCookie)
      .send({ module_id: f.module.id, url: 'a.example' });
    expect(onModule.status).toBe(404);
  });

  it('keeps one user s links out of another s list of the same module', async () => {
    const f = await fixture();
    await createUser(f.db, { username: 'bob' });
    const bobCookie = await login(f.app, 'bob');
    // Bob racks the same module record, then looks at its links.
    const bob = await f.db.models.User.findOne({ where: { username: 'bob' } });
    await mapModule(f.db, bob.id, f.module.id);
    await post(f, { module_id: f.module.id, url: 'alice.example' });
    const bobsView = await request(f.app)
      .get(`/api/links?module_id=${f.module.id}`)
      .set('Cookie', bobCookie);
    expect(bobsView.body).toEqual([]);
  });

  it('edits and deletes a link, and refuses to edit someone else s', async () => {
    const f = await fixture();
    const created = await post(f, { module_id: f.module.id, url: 'a.example', title: 'A' });
    const edited = await request(f.app)
      .put(`/api/links/${created.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ url: 'b.example/manual', title: '', description: 'the firmware thread' });
    expect(edited.body.url).toBe('https://b.example/manual');
    // An emptied title falls back to the host rather than leaving nothing to
    // click on.
    expect(edited.body.title).toBe('b.example');
    expect(edited.body.description).toBe('the firmware thread');

    const bad = await request(f.app)
      .put(`/api/links/${created.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);

    await createUser(f.db, { username: 'bob' });
    const bobCookie = await login(f.app, 'bob');
    expect(
      (await request(f.app).delete(`/api/links/${created.body.id}`).set('Cookie', bobCookie)).status
    ).toBe(404);

    expect(
      (await request(f.app).delete(`/api/links/${created.body.id}`).set('Cookie', f.aliceCookie))
        .status
    ).toBe(200);
    const list = await request(f.app)
      .get(`/api/links?module_id=${f.module.id}`)
      .set('Cookie', f.aliceCookie);
    expect(list.body).toEqual([]);
  });

  it('takes a patch s links with the patch', async () => {
    const f = await fixture();
    await post(f, { patch_id: f.patchId, url: 'a.example' });
    await request(f.app).delete(`/api/patches/${f.patchId}`).set('Cookie', f.aliceCookie);
    const { rows } = await f.db.query('SELECT count(*)::int AS n FROM resource_links');
    expect(rows[0].n).toBe(0);
  });
});
