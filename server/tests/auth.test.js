import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb, createUser, login } from './helpers.js';
import { createApp } from '../src/app.js';
import { generatePassword } from '../src/auth.js';
import { ensureAdmin } from '../src/setupAdmin.js';

describe('auth', () => {
  it('logs in with valid credentials and sets a session cookie', async () => {
    const { app } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'alice', is_admin: false });
    expect(res.headers['set-cookie'][0]).toMatch(/session=/);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });

  it('rejects a wrong password', async () => {
    const { app } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown user', async () => {
    const { app } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'password123' });
    expect(res.status).toBe(401);
  });

  it('requires both fields', async () => {
    const { app } = await createTestApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'alice' });
    expect(res.status).toBe(400);
  });

  it('returns the current user from /me', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app).get('/api/auth/me').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
  });

  it('rejects /me without a session', async () => {
    const { app } = await createTestApp();
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const { app, aliceCookie } = await createTestApp();
    await request(app).post('/api/auth/logout').set('Cookie', aliceCookie);
    const res = await request(app).get('/api/auth/me').set('Cookie', aliceCookie);
    expect(res.status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const db = await createTestDb();
    const app = createApp(db);
    const user = await createUser(db, { username: 'bob' });
    await db.query(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES ('stale', $1, now() - interval '1 hour')",
      [user.id]
    );
    const res = await request(app).get('/api/auth/me').set('Cookie', 'session=stale');
    expect(res.status).toBe(401);
  });
});

describe('generatePassword', () => {
  it('generates distinct passwords of the requested length', () => {
    const a = generatePassword(24);
    const b = generatePassword(24);
    expect(a).toHaveLength(24);
    expect(b).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

describe('ensureAdmin', () => {
  it('creates an admin with a random password and stores only a hash', async () => {
    const db = await createTestDb();
    const result = await ensureAdmin(db);
    expect(result.created).toBe(true);
    expect(result.username).toBe('admin');
    expect(result.password).toHaveLength(24);

    const { rows } = await db.query('SELECT * FROM users WHERE is_admin = TRUE');
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toContain(result.password);

    // The generated password actually works for login.
    const app = createApp(db);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: result.password });
    expect(res.status).toBe(200);
    expect(res.body.is_admin).toBe(true);
  });

  it('does nothing when an admin already exists', async () => {
    const db = await createTestDb();
    await ensureAdmin(db);
    const second = await ensureAdmin(db);
    expect(second.created).toBe(false);
    expect(second.password).toBeUndefined();
    const { rows } = await db.query('SELECT * FROM users');
    expect(rows).toHaveLength(1);
  });

  it('resets the password when asked', async () => {
    const db = await createTestDb();
    const first = await ensureAdmin(db);
    const second = await ensureAdmin(db, { reset: true });
    expect(second.reset).toBe(true);
    expect(second.password).not.toBe(first.password);

    const app = createApp(db);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: second.password });
    expect(res.status).toBe(200);
  });
});

describe('user management', () => {
  it('lets the admin create a non-admin user with a generated password', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'newuser' });
    expect(res.status).toBe(201);
    expect(res.body.is_admin).toBe(false);
    expect(res.body.generated_password).toBeDefined();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'newuser', password: res.body.generated_password });
    expect(loginRes.status).toBe(200);
  });

  it('always creates non-admins even if is_admin is sent', async () => {
    const { app, adminCookie, db } = await createTestApp();
    await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'sneaky', password: 'password123', is_admin: true });
    const { rows } = await db.query("SELECT is_admin FROM users WHERE username = 'sneaky'");
    expect(rows[0].is_admin).toBe(false);
  });

  it('rejects duplicate usernames', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'ALICE' });
    expect(res.status).toBe(409);
  });

  it('rejects short passwords and invalid usernames', async () => {
    const { app, adminCookie } = await createTestApp();
    expect(
      (
        await request(app)
          .post('/api/users')
          .set('Cookie', adminCookie)
          .send({ username: 'ok', password: 'short' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/users')
          .set('Cookie', adminCookie)
          .send({ username: 'bad name!' })
      ).status
    ).toBe(400);
  });

  it('forbids non-admins from managing users', async () => {
    const { app, aliceCookie } = await createTestApp();
    expect((await request(app).get('/api/users').set('Cookie', aliceCookie)).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/users')
          .set('Cookie', aliceCookie)
          .send({ username: 'x' })
      ).status
    ).toBe(403);
  });

  it('lists users for the admin', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((u) => u.username)).toEqual(['admin', 'alice']);
    expect(res.body[0]).not.toHaveProperty('password_hash');
  });

  it('deletes users but not yourself', async () => {
    const { app, adminCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    expect(
      (await request(app).delete(`/api/users/${rows[0].id}`).set('Cookie', adminCookie)).status
    ).toBe(200);
    const { rows: admins } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    expect(
      (await request(app).delete(`/api/users/${admins[0].id}`).set('Cookie', adminCookie)).status
    ).toBe(400);
  });
});
