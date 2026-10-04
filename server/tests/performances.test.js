import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, insertModule, login, mapModule } from './helpers.js';
import { readVideo } from '../src/services/performances.js';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Alice has a module and a patch; bob is another account, admin is the admin.
async function fixture() {
  const app = await createTestApp();
  const alice = await app.db.models.User.findOne({ where: { username: 'alice' } });
  const module = await insertModule(app.db, alice.id);
  const { rows: racks } = await app.db.query('SELECT id FROM racks WHERE user_id = $1', [alice.id]);
  const patch = await request(app.app)
    .post('/api/patches')
    .set('Cookie', app.aliceCookie)
    .send({ rack_id: racks[0].id, name: 'Krell' });
  const bob = await createUser(app.db, { username: 'bob' });
  const bobCookie = await login(app.app, 'bob');
  return { ...app, alice, bob, bobCookie, module, rackId: racks[0].id, patchId: patch.body.id };
}

const share = (f, body, cookie = f.aliceCookie) =>
  request(f.app).post('/api/performances').set('Cookie', cookie).send({ url: YT, title: 'Evening set', ...body });

describe('readVideo', () => {
  it('reduces any form of YouTube link to the video id and a canonical URL', () => {
    for (const url of [
      YT,
      'youtu.be/dQw4w9WgXcQ?t=42',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=abc',
    ]) {
      expect(readVideo(url), url).toEqual({ video_id: 'dQw4w9WgXcQ', url: YT });
    }
  });

  it('refuses anything that is not a YouTube video', () => {
    for (const bad of ['', 'https://vimeo.com/12345', 'https://www.youtube.com/@channel', 'javascript:alert(1)']) {
      expect(readVideo(bad).error, bad).toBeTruthy();
    }
  });
});

describe('/api/performances', () => {
  it('shares a video everyone can see, with the modules and the patch beside it', async () => {
    const f = await fixture();
    const res = await share(f, {
      description: 'Live at the kitchen table',
      patch_id: f.patchId,
      module_ids: [f.module.id],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Evening set',
      video_id: 'dQw4w9WgXcQ',
      url: YT,
      owner_username: 'alice',
      mine: true,
      patch: { id: f.patchId, name: 'Krell', live: true },
    });
    expect(res.body.modules).toEqual([
      expect.objectContaining({ id: f.module.id, name: 'Maths', yours: true }),
    ]);

    // Bob never shared anything and was shared nothing: he sees it anyway.
    const list = await request(f.app).get('/api/performances').set('Cookie', f.bobCookie);
    expect(list.body.total).toBe(1);
    expect(list.body.performances[0]).toMatchObject({
      id: res.body.id,
      owner_username: 'alice',
      mine: false,
      can_delete: false,
      module_count: 1,
      comment_count: 0,
    });
    const page = await request(f.app).get(`/api/performances/${res.body.id}`).set('Cookie', f.bobCookie);
    expect(page.status).toBe(200);
    // The module is alice's to open and only a name to bob.
    expect(page.body.modules[0].yours).toBe(false);

    // ...and he may read the patch through it, as a shared patch reads.
    const patch = await request(f.app).get(`/api/performances/${res.body.id}/patch`).set('Cookie', f.bobCookie);
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ id: f.patchId, name: 'Krell', shared: true, owner_username: 'alice' });
    expect(patch.body.modules).toHaveLength(1);
    // But not the patch itself: the performance is the only door.
    expect((await request(f.app).get(`/api/patches/${f.patchId}`).set('Cookie', f.bobCookie)).status).toBe(404);
  });

  it('refuses a link that is not a video, a blank title, another user s patch and a module not racked', async () => {
    const f = await fixture();
    expect((await share(f, { url: 'https://vimeo.com/1' })).status).toBe(400);
    expect((await share(f, { title: '  ' })).status).toBe(400);
    // Bob names alice's patch and alice's module as his own.
    expect((await share(f, { patch_id: f.patchId }, f.bobCookie)).status).toBe(400);
    const notRacked = await share(f, { module_ids: [f.module.id] }, f.bobCookie);
    expect(notRacked.status).toBe(400);
    expect(notRacked.body.error).toContain(`Module ${f.module.id}`);
    expect((await share(f, { module_ids: 'x' })).status).toBe(400);
    // Once bob racks the same module record it is his to list.
    await mapModule(f.db, f.bob.id, f.module.id);
    expect((await share(f, { module_ids: [f.module.id] }, f.bobCookie)).status).toBe(201);
  });

  it('lets the author edit it, withdraw the patch and replace the module list, and nobody else', async () => {
    const f = await fixture();
    const other = await insertModule(f.db, f.alice.id, { manufacturer: 'Mutable', name: 'Plaits' });
    const created = await share(f, { patch_id: f.patchId, module_ids: [f.module.id] });
    const id = created.body.id;

    const edited = await request(f.app)
      .put(`/api/performances/${id}`)
      .set('Cookie', f.aliceCookie)
      .send({ title: 'Morning set', patch_id: null, module_ids: [other.id, f.module.id] });
    expect(edited.status).toBe(200);
    expect(edited.body.title).toBe('Morning set');
    expect(edited.body.patch).toBeNull();
    expect(edited.body.modules.map((m) => m.name)).toEqual(['Plaits', 'Maths']);
    // The video stays as it was when the edit says nothing about it.
    expect(edited.body.video_id).toBe('dQw4w9WgXcQ');

    const byBob = await request(f.app)
      .put(`/api/performances/${id}`)
      .set('Cookie', f.bobCookie)
      .send({ title: 'Mine now' });
    expect(byBob.status).toBe(403);
    expect((await request(f.app).delete(`/api/performances/${id}`).set('Cookie', f.bobCookie)).status).toBe(403);
    // Not even the admin edits someone's words — but the admin can take it down.
    expect(
      (await request(f.app).put(`/api/performances/${id}`).set('Cookie', f.adminCookie).send({ title: 'x' })).status
    ).toBe(403);
    expect((await request(f.app).delete(`/api/performances/${id}`).set('Cookie', f.adminCookie)).status).toBe(200);
    expect((await request(f.app).get(`/api/performances/${id}`).set('Cookie', f.aliceCookie)).status).toBe(404);
    const { rows } = await f.db.query('SELECT count(*)::int AS n FROM performance_modules');
    expect(rows[0].n).toBe(0);
  });

  it('keeps the name of a patch that was deleted, and shows no patch for it', async () => {
    const f = await fixture();
    const created = await share(f, { patch_id: f.patchId });
    await request(f.app).delete(`/api/patches/${f.patchId}`).set('Cookie', f.aliceCookie);
    const page = await request(f.app).get(`/api/performances/${created.body.id}`).set('Cookie', f.bobCookie);
    expect(page.body.patch).toEqual({ id: null, name: 'Krell', live: false });
    expect(
      (await request(f.app).get(`/api/performances/${created.body.id}/patch`).set('Cookie', f.bobCookie)).status
    ).toBe(404);
  });

  it('takes comments from anyone, removed by their writer, the author or an admin', async () => {
    const f = await fixture();
    const created = await share(f, {});
    const id = created.body.id;
    const comments = `/api/performances/${id}/comments`;

    expect((await request(f.app).post(comments).set('Cookie', f.bobCookie).send({ body: '   ' })).status).toBe(400);
    const bobs = await request(f.app).post(comments).set('Cookie', f.bobCookie).send({ body: 'Lovely patch' });
    expect(bobs.status).toBe(201);
    expect(bobs.body).toMatchObject({ username: 'bob', body: 'Lovely patch', mine: true, can_delete: true });
    const alices = await request(f.app).post(comments).set('Cookie', f.aliceCookie).send({ body: 'Thanks!' });
    const admins = await request(f.app).post(comments).set('Cookie', f.adminCookie).send({ body: 'Nice' });

    // Read back in order, each saying what the reader may do with it.
    const page = await request(f.app).get(`/api/performances/${id}`).set('Cookie', f.bobCookie);
    expect(page.body.comments.map((c) => c.username)).toEqual(['bob', 'alice', 'admin']);
    expect(page.body.comments.map((c) => c.can_delete)).toEqual([true, false, false]);
    expect(page.body.comment_count).toBe(3);

    // Bob may not remove alice's; alice (the author) may remove bob's; the
    // admin may remove anyone's.
    expect(
      (await request(f.app).delete(`${comments}/${alices.body.id}`).set('Cookie', f.bobCookie)).status
    ).toBe(403);
    expect(
      (await request(f.app).delete(`${comments}/${bobs.body.id}`).set('Cookie', f.aliceCookie)).status
    ).toBe(200);
    expect(
      (await request(f.app).delete(`${comments}/${alices.body.id}`).set('Cookie', f.adminCookie)).status
    ).toBe(200);
    expect(
      (await request(f.app).delete(`${comments}/${admins.body.id}`).set('Cookie', f.adminCookie)).status
    ).toBe(200);
    expect(
      (await request(f.app).delete(`${comments}/${admins.body.id}`).set('Cookie', f.adminCookie)).status
    ).toBe(404);
    const list = await request(f.app).get('/api/performances').set('Cookie', f.aliceCookie);
    expect(list.body.performances[0].comment_count).toBe(0);
  });

  it('pages newest first and narrows to the viewer s own', async () => {
    const f = await fixture();
    const ids = [];
    for (const title of ['one', 'two', 'three']) ids.push((await share(f, { title })).body.id);
    await share(f, { title: 'bobs' }, f.bobCookie);

    const first = await request(f.app).get('/api/performances?limit=2').set('Cookie', f.bobCookie);
    expect(first.body.total).toBe(4);
    expect(first.body.performances.map((p) => p.title)).toEqual(['bobs', 'three']);
    expect(first.body.has_more).toBe(true);
    const second = await request(f.app)
      .get(`/api/performances?limit=2&before=${first.body.next_before}`)
      .set('Cookie', f.bobCookie);
    expect(second.body.performances.map((p) => p.title)).toEqual(['two', 'one']);
    expect(second.body.has_more).toBe(false);

    const mine = await request(f.app).get('/api/performances?mine=1').set('Cookie', f.bobCookie);
    expect(mine.body.total).toBe(1);
    expect(mine.body.performances[0].title).toBe('bobs');
  });

  it('is nothing to a visitor without a session', async () => {
    const f = await fixture();
    const created = await share(f, { patch_id: f.patchId });
    expect(created.body.public).toBe(false);
    expect((await request(f.app).get('/api/performances')).status).toBe(401);
    expect((await request(f.app).get(`/api/performances/${created.body.id}`)).status).toBe(401);
    expect((await request(f.app).get(`/api/performances/${created.body.id}/patch`)).status).toBe(401);
    expect((await request(f.app).get('/api/performances/999')).status).toBe(404);
  });

  it('opens a public performance, its patch and its comments to anyone with the link, but takes no comment from them', async () => {
    const f = await fixture();
    expect((await share(f, { public: 'yes' })).status).toBe(400);
    const created = await share(f, { public: true, patch_id: f.patchId, module_ids: [f.module.id] });
    expect(created.body.public).toBe(true);
    await request(f.app)
      .post(`/api/performances/${created.body.id}/comments`)
      .set('Cookie', f.bobCookie)
      .send({ body: 'Lovely' });

    const page = await request(f.app).get(`/api/performances/${created.body.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ title: 'Evening set', owner_username: 'alice', mine: false, can_delete: false });
    expect(page.body.modules[0]).toMatchObject({ name: 'Maths', yours: false });
    expect(page.body.comments).toHaveLength(1);
    expect(page.body.comments[0]).toMatchObject({ username: 'bob', can_delete: false });
    const patch = await request(f.app).get(`/api/performances/${created.body.id}/patch`);
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ name: 'Krell', shared: true });

    expect(
      (await request(f.app).post(`/api/performances/${created.body.id}/comments`).send({ body: 'anon' })).status
    ).toBe(401);
    // The list stays the room's.
    expect((await request(f.app).get('/api/performances')).status).toBe(401);

    // The author closes it again and the link stops working for visitors.
    await request(f.app)
      .put(`/api/performances/${created.body.id}`)
      .set('Cookie', f.aliceCookie)
      .send({ public: false });
    expect((await request(f.app).get(`/api/performances/${created.body.id}`)).status).toBe(401);
  });
});
