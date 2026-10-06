import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser } from './helpers.js';
import {
  ACTIVE_WINDOW_DAYS,
  admitReturningUser,
  countActiveUsers,
  isActiveUser,
  registrationStatus,
} from '../src/services/activeUsers.js';
import { getConfig, setConfig } from '../src/services/config.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n, now = Date.now()) => new Date(now - n * DAY);

const setLimit = (app, adminCookie, max_active_users) =>
  request(app).put('/api/config').set('Cookie', adminCookie).send({ max_active_users });

const create = (app, adminCookie, username) =>
  request(app)
    .post('/api/users')
    .set('Cookie', adminCookie)
    .send({ username, email: `${username}@example.com`, password: 'password123' });

describe('active users', () => {
  it('counts a login in the last two weeks, or a new account that has not logged in yet', () => {
    const now = Date.now();
    expect(isActiveUser({ last_login_at: daysAgo(1, now), created_at: daysAgo(400, now) }, now)).toBe(true);
    expect(isActiveUser({ last_login_at: daysAgo(13, now), created_at: daysAgo(400, now) }, now)).toBe(true);
    expect(isActiveUser({ last_login_at: daysAgo(15, now), created_at: daysAgo(400, now) }, now)).toBe(false);
    // Never logged in: the account is active for the two weeks after it is made.
    expect(isActiveUser({ last_login_at: null, created_at: daysAgo(2, now) }, now)).toBe(true);
    expect(isActiveUser({ last_login_at: null, created_at: daysAgo(20, now) }, now)).toBe(false);
    // A recent creation does not keep an account active once it has logged in and gone quiet.
    expect(isActiveUser({ last_login_at: daysAgo(15, now), created_at: daysAgo(16, now) }, now)).toBe(false);
    expect(ACTIVE_WINDOW_DAYS).toBe(14);
  });

  it('is a config key: a whole number, 0 for no ceiling', async () => {
    const { app, adminCookie, aliceCookie } = await createTestApp();
    const before = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(before.body.max_active_users).toBe('0');

    const set = await setLimit(app, adminCookie, 10);
    expect(set.status).toBe(200);
    expect(set.body.max_active_users).toBe('10');

    for (const bad of [-1, 2.5, 'ten', '', true]) {
      const res = await setLimit(app, adminCookie, bad);
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error).toMatch(/max_active_users/);
    }
    expect((await request(app).get('/api/config').set('Cookie', adminCookie)).body.max_active_users).toBe('10');

    // The admin's, not everybody's.
    expect((await setLimit(app, aliceCookie, 3)).status).toBe(403);
    expect((await request(app).get('/api/users/registration').set('Cookie', aliceCookie)).status).toBe(403);
  });

  it('closes registration once the active count reaches the ceiling, and says so', async () => {
    const { app, adminCookie, db } = await createTestApp();
    // The fixture: the admin and alice, both logged in just now → 2 active.
    const open = await request(app).get('/api/users/registration').set('Cookie', adminCookie);
    expect(open.body).toEqual({ limit: 0, active: 2, window_days: 14, open: true });

    await setLimit(app, adminCookie, 3);
    expect((await request(app).get('/api/users/registration').set('Cookie', adminCookie)).body).toEqual({
      limit: 3,
      active: 2,
      window_days: 14,
      open: true,
    });

    // The third account fills the ceiling the moment it is made — it has
    // not logged in, but it is new.
    const third = await create(app, adminCookie, 'carol');
    expect(third.status).toBe(201);
    expect(third.body.active).toBe(true);
    const full = await request(app).get('/api/users/registration').set('Cookie', adminCookie);
    expect(full.body).toEqual({ limit: 3, active: 3, window_days: 14, open: false });

    const refused = await create(app, adminCookie, 'dave');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('registration_closed');
    expect(refused.body.error).toMatch(/Registration is closed: 3 of 3 active users/);
    expect(await db.models.User.findOne({ where: { username: 'dave' } })).toBeNull();

    // A user gone quiet frees their place.
    const carol = await db.models.User.findOne({ where: { username: 'carol' } });
    await carol.update({ created_at: daysAgo(30), last_login_at: daysAgo(20) });
    const list = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(list.body.find((u) => u.username === 'carol').active).toBe(false);
    expect(list.body.find((u) => u.username === 'alice').active).toBe(true);
    expect((await create(app, adminCookie, 'dave')).status).toBe(201);

    // Lifting the ceiling opens it again however many are active.
    await setLimit(app, adminCookie, 0);
    expect((await create(app, adminCookie, 'erin')).status).toBe(201);
  });

  it('lets an inactive user back in and raises the ceiling to fit them', async () => {
    const { app, adminCookie, db } = await createTestApp();
    await createUser(db, { username: 'carol' });
    const carol = await db.models.User.findOne({ where: { username: 'carol' } });
    await carol.update({ created_at: daysAgo(60), last_login_at: daysAgo(30) });
    await setLimit(app, adminCookie, 2); // admin + alice fill it
    expect((await registrationStatus(db)).open).toBe(false);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'carol', password: 'password123' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const config = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(config.body.max_active_users).toBe('3');
    expect((await request(app).get('/api/users/registration').set('Cookie', adminCookie)).body).toEqual({
      limit: 3,
      active: 3,
      window_days: 14,
      open: false,
    });

    // Logging in again is not another return: the ceiling stays where it is.
    await request(app).post('/api/auth/login').send({ username: 'carol', password: 'password123' });
    expect((await getConfig(db)).max_active_users).toBe('3');
  });

  it('moves the ceiling only when a return takes the count past it', async () => {
    const { db } = await createTestApp();
    const now = Date.now();
    await createUser(db, { username: 'carol' });
    const carol = await db.models.User.findOne({ where: { username: 'carol' } });
    await carol.update({ created_at: daysAgo(60, now), last_login_at: new Date(now) });
    const quiet = { last_login_at: daysAgo(30, now), created_at: daysAgo(60, now) };

    // No ceiling: nothing to move.
    expect(await admitReturningUser(db, quiet, { now })).toBeNull();
    expect((await getConfig(db)).max_active_users).toBe('0');

    // Room under it: the number the admin set stands.
    await setConfig(db, { max_active_users: 5 });
    expect(await countActiveUsers(db, { now })).toBe(3);
    expect(await admitReturningUser(db, quiet, { now })).toBeNull();
    expect((await getConfig(db)).max_active_users).toBe('5');

    // Already active before this login: not a return.
    await setConfig(db, { max_active_users: 2 });
    expect(await admitReturningUser(db, { last_login_at: daysAgo(1, now), created_at: daysAgo(60, now) }, { now })).toBeNull();
    expect((await getConfig(db)).max_active_users).toBe('2');

    expect(await admitReturningUser(db, quiet, { now })).toBe(3);
    expect((await getConfig(db)).max_active_users).toBe('3');
  });
});
