import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb, createUser, login } from './helpers.js';
import { createApp } from '../src/app.js';
import {
  generatePassword,
  hashPassword,
  passwordProblem,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  PBKDF2_DIGEST,
  PBKDF2_ITERATIONS,
} from '../src/auth.js';
import { ensureAdmin } from '../src/setupAdmin.js';
import { issueDeviceToken, getDeviceTokenUser } from '../src/services/deviceAuth.js';

describe('PBKDF2 password hashing', () => {
  it('hashes in the self-describing pbkdf2 format and verifies round-trip', () => {
    const stored = hashPassword('correct horse battery staple');
    const [scheme, digest, iterations, salt, key] = stored.split('$');
    expect(scheme).toBe('pbkdf2');
    expect(digest).toBe(PBKDF2_DIGEST);
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('salts every hash uniquely', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('verifies with the parameters stored in the hash, not the constants', () => {
    // A hash produced with different parameters still verifies — the
    // constants can be raised later without invalidating existing hashes.
    const salt = 'aabbccddeeff00112233445566778899';
    const key = crypto
      .pbkdf2Sync('pw', Buffer.from(salt, 'hex'), 1000, 24, 'sha256')
      .toString('hex');
    const legacy = `pbkdf2$sha256$1000$${salt}$${key}`;
    expect(verifyPassword('pw', legacy)).toBe(true);
    expect(verifyPassword('not pw', legacy)).toBe(false);
  });

  it('never authenticates against malformed or foreign hashes', () => {
    expect(verifyPassword('pw', '')).toBe(false);
    expect(verifyPassword('pw', null)).toBe(false);
    expect(verifyPassword('pw', '$2a$10$abcdefghijklmnopqrstuv')).toBe(false); // bcrypt
    expect(verifyPassword('pw', 'pbkdf2$nope$210000$00$00')).toBe(false); // bad digest
    expect(verifyPassword('pw', 'pbkdf2$sha512$-1$00$00')).toBe(false); // bad iterations
    expect(verifyPassword('pw', 'pbkdf2$sha512$210000$00$')).toBe(false); // empty key
  });
});

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

  it('omits Secure from the session cookie on a plain-HTTP deployment', async () => {
    const { app } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'password123' });
    expect(res.headers['set-cookie'][0]).not.toMatch(/Secure/i);
  });

  it('marks the session cookie Secure when SECURE_COOKIES is set', async () => {
    const { app, aliceCookie } = await createTestApp();
    const previous = process.env.SECURE_COOKIES;
    process.env.SECURE_COOKIES = '1';
    try {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'password123' });
      expect(login.headers['set-cookie'][0]).toMatch(/Secure/i);
      // clearCookie must repeat the attributes or the browser keeps the cookie.
      const logout = await request(app).post('/api/auth/logout').set('Cookie', aliceCookie);
      expect(logout.headers['set-cookie'][0]).toMatch(/Secure/i);
    } finally {
      if (previous === undefined) delete process.env.SECURE_COOKIES;
      else process.env.SECURE_COOKIES = previous;
    }
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
    const app = createApp(db, { rateLimit: false });
    const user = await createUser(db, { username: 'bob' });
    await db.query(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES ('stale', $1, now() - interval '1 hour')",
      [user.id]
    );
    const res = await request(app).get('/api/auth/me').set('Cookie', 'session=stale');
    expect(res.status).toBe(401);
  });
});

describe('password policy', () => {
  it('accepts exactly the minimum length and rejects one character less', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least 8 characters/);
  });

  it('names the field it is complaining about', () => {
    expect(passwordProblem('short', { label: 'new password' })).toMatch(/^new password must be/);
  });

  it('rejects anything that is not a string or number', () => {
    // JSON bodies can carry objects/arrays; String()-ing those used to produce
    // a long-enough value ('[object Object]') that sailed past a length check.
    expect(passwordProblem({ toString: () => 'longenough' })).toMatch(/required/);
    expect(passwordProblem(['longenough'])).toMatch(/required/);
    expect(passwordProblem(null)).toMatch(/required/);
    expect(passwordProblem(undefined)).toMatch(/required/);
  });

  it('enforces the minimum on a self-service password change', async () => {
    const { app, aliceCookie } = await createTestApp();
    const change = (newPassword) =>
      request(app)
        .post('/api/auth/password')
        .set('Cookie', aliceCookie)
        .send({ current_password: 'password123', new_password: newPassword });

    const short = await change('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 8 characters/);

    const object = await change({ length: 40 });
    expect(object.status).toBe(400);

    // The rejected attempts changed nothing — the old password still works.
    expect(
      (await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' }))
        .status
    ).toBe(200);

    const ok = await change('a'.repeat(MIN_PASSWORD_LENGTH));
    expect(ok.status).toBe(200);
  });

  it('revokes the user\'s device tokens on a self-service password change', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const { accessToken } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: 'cvosc',
      name: 'Bench scope',
      scopes: 'oscilloscope',
    });
    expect(await getDeviceTokenUser(db, accessToken)).not.toBeNull();

    const changed = await request(app)
      .post('/api/auth/password')
      .set('Cookie', aliceCookie)
      .send({ current_password: 'password123', new_password: 'a-brand-new-password' });
    expect(changed.status).toBe(200);

    // The device bearer token no longer authenticates.
    expect(await getDeviceTokenUser(db, accessToken)).toBeNull();
  });

  it('enforces the minimum when an admin creates a user', async () => {
    const { app, db, adminCookie } = await createTestApp();
    const create = (username, password) =>
      request(app)
        .post('/api/users')
        .set('Cookie', adminCookie)
        .send({ username, password, email: `${username}@example.net` });

    const short = await create('shorty', 'a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 8 characters/);
    // The rejection happened before the insert.
    expect(await db.models.User.findOne({ where: { username: 'shorty' } })).toBeNull();

    const ok = await create('minimal', 'a'.repeat(MIN_PASSWORD_LENGTH));
    expect(ok.status).toBe(201);
  });

  it('enforces the minimum when an admin resets a password', async () => {
    const { app, db, adminCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });

    const short = await request(app)
      .post(`/api/users/${alice.id}/password`)
      .set('Cookie', adminCookie)
      .send({ password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 8 characters/);

    // Rejected before anything was written: the old password still logs in.
    expect(
      (await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' }))
        .status
    ).toBe(200);

    const ok = await request(app)
      .post(`/api/users/${alice.id}/password`)
      .set('Cookie', adminCookie)
      .send({ password: 'a'.repeat(MIN_PASSWORD_LENGTH) });
    expect(ok.status).toBe(200);
  });

  it('generates passwords that clear the minimum', () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(passwordProblem(generatePassword())).toBeNull();
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
  it('creates an admin with a random hex password and stores only a hash', async () => {
    const db = await createTestDb();
    const result = await ensureAdmin(db);
    expect(result.created).toBe(true);
    expect(result.username).toBe('admin');
    expect(result.password).toMatch(/^[0-9a-f]{32}$/);

    const { rows } = await db.query('SELECT * FROM users WHERE is_admin = TRUE');
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toContain(result.password);
    expect(rows[0].must_change_password).toBe(true);

    // The generated password actually works for login.
    const app = createApp(db, { rateLimit: false });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: result.password });
    expect(res.status).toBe(200);
    expect(res.body.is_admin).toBe(true);
    expect(res.body.must_change_password).toBe(true);
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

  it('resets the password when asked, kills sessions, and forces a change again', async () => {
    const db = await createTestDb();
    const first = await ensureAdmin(db);
    const app = createApp(db, { rateLimit: false });
    const cookie = await login(app, 'admin', first.password);

    const second = await ensureAdmin(db, { reset: true });
    expect(second.reset).toBe(true);
    expect(second.password).not.toBe(first.password);
    expect(second.password).toMatch(/^[0-9a-f]{32}$/);

    // The pre-reset session is gone and the old password no longer works.
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'admin', password: first.password })
      ).status
    ).toBe(401);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: second.password });
    expect(res.status).toBe(200);
    expect(res.body.must_change_password).toBe(true);
  });
});

describe('forced password change', () => {
  // Fixture: an admin fresh out of ensureAdmin, logged in with the generated
  // password and therefore flagged must_change_password.
  async function freshAdmin() {
    const db = await createTestDb();
    const { password } = await ensureAdmin(db);
    const app = createApp(db, { rateLimit: false });
    const cookie = await login(app, 'admin', password);
    return { db, app, cookie, password };
  }

  it('locks a flagged user out of everything except the auth endpoints', async () => {
    const { app, cookie } = await freshAdmin();
    const blocked = await request(app).get('/api/modules').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('password_change_required');
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(403);

    // /me still works so the client can see the flag.
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.must_change_password).toBe(true);
  });

  it('rejects a change with the wrong current password or a short new one', async () => {
    const { app, cookie, password } = await freshAdmin();
    expect(
      (
        await request(app)
          .post('/api/auth/password')
          .set('Cookie', cookie)
          .send({ current_password: 'wrong', new_password: 'newpassword1' })
      ).status
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/password')
          .set('Cookie', cookie)
          .send({ current_password: password, new_password: 'short' })
      ).status
    ).toBe(400);
    expect(
      (await request(app).post('/api/auth/password').set('Cookie', cookie).send({})).status
    ).toBe(400);
    // Still locked out.
    expect((await request(app).get('/api/modules').set('Cookie', cookie)).status).toBe(403);
  });

  it('clears the flag and unlocks the app after a successful change', async () => {
    const { app, cookie, password } = await freshAdmin();
    const res = await request(app)
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .send({ current_password: password, new_password: 'my-new-password' });
    expect(res.status).toBe(200);
    expect(res.body.must_change_password).toBe(false);

    expect((await request(app).get('/api/modules').set('Cookie', cookie)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'admin', password: 'my-new-password' })
      ).status
    ).toBe(200);
  });

  it('lets a regular user change their own password with the current one', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/password')
      .set('Cookie', aliceCookie)
      .send({ current_password: 'password123', new_password: 'brand-new-pw' });
    expect(res.status).toBe(200);

    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'alice', password: 'password123' })
      ).status
    ).toBe(401);
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'brand-new-pw' });
    expect(relogin.status).toBe(200);
    expect(relogin.body.must_change_password).toBe(false);
  });

  it('keeps the current session but logs out other sessions on change', async () => {
    const { app } = await createTestApp();
    const first = await login(app, 'alice');
    const second = await login(app, 'alice');
    await request(app)
      .post('/api/auth/password')
      .set('Cookie', second)
      .send({ current_password: 'password123', new_password: 'brand-new-pw' });
    expect((await request(app).get('/api/auth/me').set('Cookie', second)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', first)).status).toBe(401);
  });
});

describe('user management', () => {
  it('lets the admin create a non-admin user with a generated password', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'newuser', email: 'newuser@example.net' });
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
      .send({ username: 'sneaky', email: 'sneaky@example.net', password: 'password123', is_admin: true });
    const { rows } = await db.query("SELECT is_admin FROM users WHERE username = 'sneaky'");
    expect(rows[0].is_admin).toBe(false);
  });

  it('rejects duplicate usernames', async () => {
    const { app, adminCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'ALICE', email: 'alice2@example.net' });
    expect(res.status).toBe(409);
  });

  it('rejects short passwords and invalid usernames', async () => {
    const { app, adminCookie } = await createTestApp();
    expect(
      (
        await request(app)
          .post('/api/users')
          .set('Cookie', adminCookie)
          .send({ username: 'ok', email: 'ok@example.net', password: 'short' })
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

  it('lets the admin reset a user password without the current one', async () => {
    const { app, adminCookie, aliceCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const res = await request(app)
      .post(`/api/users/${rows[0].id}/password`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.generated_password).toBeDefined();

    // Alice's old password and old session are dead.
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'alice', password: 'password123' })
      ).status
    ).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', aliceCookie)).status).toBe(401);

    // The generated password works and forces a change at login.
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: res.body.generated_password });
    expect(relogin.status).toBe(200);
    expect(relogin.body.must_change_password).toBe(true);
  });

  it('lets the admin reset a user password to a chosen value', async () => {
    const { app, adminCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const res = await request(app)
      .post(`/api/users/${rows[0].id}/password`)
      .set('Cookie', adminCookie)
      .send({ password: 'chosen-by-admin' });
    expect(res.status).toBe(200);
    expect(res.body.generated_password).toBeUndefined();
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'alice', password: 'chosen-by-admin' })
      ).status
    ).toBe(200);
  });

  it('rejects admin password resets on yourself, short passwords, and unknown users', async () => {
    const { app, adminCookie, aliceCookie, db } = await createTestApp();
    const { rows: admins } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    const { rows: alices } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    expect(
      (
        await request(app)
          .post(`/api/users/${admins[0].id}/password`)
          .set('Cookie', adminCookie)
          .send({})
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/users/${alices[0].id}/password`)
          .set('Cookie', adminCookie)
          .send({ password: 'short' })
      ).status
    ).toBe(400);
    expect(
      (await request(app).post('/api/users/9999/password').set('Cookie', adminCookie).send({}))
        .status
    ).toBe(404);
    // Non-admins cannot reach the endpoint at all.
    expect(
      (
        await request(app)
          .post(`/api/users/${admins[0].id}/password`)
          .set('Cookie', aliceCookie)
          .send({})
      ).status
    ).toBe(403);
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

describe('email address', () => {
  it('is served on /me and at login, with whether it is confirmed', async () => {
    const { app, aliceCookie } = await createTestApp();
    const me = await request(app).get('/api/auth/me').set('Cookie', aliceCookie);
    expect(me.body.email).toBe('alice@example.org');
    expect(me.body.email_verified_at).toMatch(/^\d{4}-/);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'password123' });
    expect(loginRes.body.email).toBe('alice@example.org');
  });

  it('changes the address with the current password, lowercased, and mails a confirmation', async () => {
    const { app, aliceCookie, db, sentMail } = await createTestApp();
    const set = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: '  Alice@Example.NET ', current_password: 'password123' });
    expect(set.status).toBe(200);
    expect(set.body.user.email).toBe('alice@example.net');
    expect(set.body.user.email_verified_at).toBeNull();
    expect(set.body.verification).toEqual({ sent: true, problem: null });

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('alice@example.net');
    expect(sentMail[0].from).toBe('rack@example.org');
    const link = sentMail[0].text.match(/https:\/\/rack\.example\.org\/verify-email\?token=([0-9a-f]{64})/);
    expect(link).not.toBeNull();

    const { rows } = await db.query("SELECT email, email_verified_at FROM users WHERE username = 'alice'");
    expect(rows[0].email).toBe('alice@example.net');
    expect(rows[0].email_verified_at).toBeNull();

    // Following the link confirms it, with no session at all.
    const confirm = await request(app).post('/api/auth/verify-email').send({ token: link[1] });
    expect(confirm.status).toBe(200);
    expect(confirm.body.email).toBe('alice@example.net');
    const me = await request(app).get('/api/auth/me').set('Cookie', aliceCookie);
    expect(me.body.email_verified_at).not.toBeNull();
    // A token is good once.
    expect((await request(app).post('/api/auth/verify-email').send({ token: link[1] })).status).toBe(400);
  });

  it('cannot be removed', async () => {
    const { app, aliceCookie } = await createTestApp();
    for (const email of ['', null, undefined, '   ']) {
      const res = await request(app)
        .put('/api/auth/email')
        .set('Cookie', aliceCookie)
        .send({ email, current_password: 'password123' });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a wrong or missing current password', async () => {
    const { app, aliceCookie } = await createTestApp();
    const missing = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'alice@example.net' });
    expect(missing.status).toBe(400);
    const wrong = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'alice@example.net', current_password: 'nope' });
    expect(wrong.status).toBe(401);
    const me = await request(app).get('/api/auth/me').set('Cookie', aliceCookie);
    expect(me.body.email).toBe('alice@example.org');
  });

  it('refuses an address that is not one, the placeholder domain included', async () => {
    const { app, aliceCookie } = await createTestApp();
    const bad = [
      'alice',
      'alice@',
      '@example.com',
      'alice@example',
      'a lice@example.com',
      `${'a'.repeat(250)}@example.com`,
      'alice@unset.invalid',
      'alice@host.test',
    ];
    for (const email of bad) {
      const res = await request(app)
        .put('/api/auth/email')
        .set('Cookie', aliceCookie)
        .send({ email, current_password: 'password123' });
      expect(res.status, email).toBe(400);
    }
  });

  it('is one account per address, whatever the case', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'ADMIN@example.org', current_password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('saving the same confirmed address again changes nothing and sends nothing', async () => {
    const { app, aliceCookie, sentMail } = await createTestApp();
    const res = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'Alice@Example.org', current_password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email_verified_at).not.toBeNull();
    expect(res.body.verification.sent).toBe(false);
    expect(sentMail).toHaveLength(0);
  });

  it('sends the confirmation again on request, not twice a minute', async () => {
    const { app, db, sentMail } = await createTestApp();
    await createUser(db, { username: 'carol', emailVerified: false });
    const cookie = await login(app, 'carol');
    const first = await request(app).post('/api/auth/verify-email/resend').set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.sent).toBe(true);
    expect(sentMail).toHaveLength(1);
    const again = await request(app).post('/api/auth/verify-email/resend').set('Cookie', cookie);
    expect(again.status).toBe(429);
    expect(sentMail).toHaveLength(1);

    // Already confirmed: nothing to send.
    const { aliceCookie } = { aliceCookie: await login(app, 'alice') };
    const done = await request(app).post('/api/auth/verify-email/resend').set('Cookie', aliceCookie);
    expect(done.status).toBe(400);
  });

  it('a token proves the address it was sent to, not whatever the address is now', async () => {
    const { app, aliceCookie, sentMail } = await createTestApp();
    await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'one@example.net', current_password: 'password123' });
    const first = sentMail[0].text.match(/token=([0-9a-f]{64})/)[1];
    await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'two@example.net', current_password: 'password123' });
    expect((await request(app).post('/api/auth/verify-email').send({ token: first })).status).toBe(400);
    for (const token of ['', 'zz', 'a'.repeat(64), null]) {
      expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(400);
    }
  });

  it('records the change even when the mail cannot go, and says so', async () => {
    const { app, aliceCookie, sentMail } = await createTestApp({ mail: false });
    const res = await request(app)
      .put('/api/auth/email')
      .set('Cookie', aliceCookie)
      .send({ email: 'alice@example.net', current_password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.net');
    expect(res.body.verification.sent).toBe(false);
    expect(res.body.verification.problem).toMatch(/Mail is not set up/);
    expect(sentMail).toHaveLength(0);
  });

  it('is not reachable while a password change is forced', async () => {
    const { app, adminCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await request(app)
      .post(`/api/users/${rows[0].id}/password`)
      .set('Cookie', adminCookie)
      .send({ password: 'temporary-pw' });
    const cookie = await login(app, 'alice', 'temporary-pw');
    const res = await request(app)
      .put('/api/auth/email')
      .set('Cookie', cookie)
      .send({ email: 'alice@example.net', current_password: 'temporary-pw' });
    expect(res.status).toBe(403);
  });

  it('is required when the admin creates a user, and the confirmation is mailed', async () => {
    const { app, adminCookie, sentMail } = await createTestApp();
    const missing = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'newuser' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/email is required/);

    const created = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'newuser', email: 'New@Example.net' });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('new@example.net');
    expect(created.body.email_verified_at).toBeNull();
    expect(created.body.verification.sent).toBe(true);
    expect(sentMail.map((m) => m.to)).toEqual(['new@example.net']);

    const list = await request(app).get('/api/users').set('Cookie', adminCookie);
    const row = list.body.find((u) => u.username === 'newuser');
    expect(row.email).toBe('new@example.net');
    expect(row.email_verified_at).toBeNull();
    expect(list.body.find((u) => u.username === 'alice').email_verified_at).not.toBeNull();

    const bad = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'another', email: 'not-an-address' });
    expect(bad.status).toBe(400);
    const taken = await request(app)
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ username: 'another', email: 'new@example.net' });
    expect(taken.status).toBe(409);
  });

  it('lets the admin change a user\'s address, which has to be confirmed again', async () => {
    const { app, adminCookie, db, sentMail } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const res = await request(app)
      .put(`/api/users/${rows[0].id}/email`)
      .set('Cookie', adminCookie)
      .send({ email: 'Alice@Example.net' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('alice@example.net');
    expect(res.body.email_verified_at).toBeNull();
    expect(res.body.verification.sent).toBe(true);
    expect(sentMail[0].to).toBe('alice@example.net');

    const token = sentMail[0].text.match(/token=([0-9a-f]{64})/)[1];
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const list = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(list.body.find((u) => u.username === 'alice').email_verified_at).not.toBeNull();

    // Not their own (that takes a password), not one that is taken, not junk.
    const { rows: me } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    expect(
      (await request(app).put(`/api/users/${me[0].id}/email`).set('Cookie', adminCookie).send({ email: 'x@example.net' })).status
    ).toBe(400);
    expect(
      (await request(app).put(`/api/users/${rows[0].id}/email`).set('Cookie', adminCookie).send({ email: 'admin@example.org' })).status
    ).toBe(409);
    expect(
      (await request(app).put(`/api/users/${rows[0].id}/email`).set('Cookie', adminCookie).send({ email: 'nope' })).status
    ).toBe(400);
    expect(
      (await request(app).put('/api/users/99999/email').set('Cookie', adminCookie).send({ email: 'x@example.net' })).status
    ).toBe(404);
  });

  it('gives an account from before the column a placeholder nobody can keep', async () => {
    const db = await createTestDb();
    const result = await ensureAdmin(db);
    const admin = await db.models.User.findOne({ where: { username: result.username } });
    expect(admin.email).toBe('admin@unset.invalid');
    expect(admin.email_verified_at).toBeNull();

    const db2 = await createTestDb();
    await ensureAdmin(db2, { email: 'Owner@Example.net' });
    expect((await db2.models.User.findOne({ where: { is_admin: true } })).email).toBe('owner@example.net');
  });
});

describe('last login', () => {
  it('is recorded on a successful login and nothing else', async () => {
    const { app, adminCookie, db } = await createTestApp();
    // The fixture logs alice in once already; a fresh user has never.
    await createUser(db, { username: 'carol' });
    const before = await request(app).get('/api/users').set('Cookie', adminCookie);
    const carolBefore = before.body.find((u) => u.username === 'carol');
    expect(carolBefore.last_login_at).toBeNull();
    expect(before.body.find((u) => u.username === 'alice').last_login_at).toMatch(/^\d{4}-/);

    await request(app).post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    const stillNone = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(stillNone.body.find((u) => u.username === 'carol').last_login_at).toBeNull();

    const start = Date.now();
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'carol', password: 'password123' });
    expect(loginRes.status).toBe(200);
    expect(new Date(loginRes.body.last_login_at).getTime()).toBeGreaterThanOrEqual(start - 1000);
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

    // Using the session is the same login continuing, not a new one.
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.last_login_at).toBe(loginRes.body.last_login_at);
    const after = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(after.body.find((u) => u.username === 'carol').last_login_at).toBe(loginRes.body.last_login_at);
  });
});

describe('account lockout', () => {
  const attempt = (app, password) =>
    request(app).post('/api/auth/login').send({ username: 'alice', password });

  it('locks the account after five wrong passwords in a row and logs it out everywhere', async () => {
    const { app, aliceCookie, db } = await createTestApp();
    for (let i = 1; i <= 4; i += 1) {
      const res = await attempt(app, 'wrong');
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    // The session from before still works: four is not five.
    expect((await request(app).get('/api/auth/me').set('Cookie', aliceCookie)).status).toBe(200);

    const fifth = await attempt(app, 'wrong');
    expect(fifth.status).toBe(403);
    expect(fifth.body.code).toBe('account_locked');

    // The right password no longer gets in, and the old session is gone.
    expect((await attempt(app, 'password123')).status).toBe(403);
    expect((await request(app).get('/api/auth/me').set('Cookie', aliceCookie)).status).toBe(401);
    const { rows } = await db.query("SELECT locked_at, locked_reason, failed_logins FROM users WHERE username = 'alice'");
    expect(rows[0].locked_at).not.toBeNull();
    expect(rows[0].locked_reason).toBe('failed_logins');
    expect(rows[0].failed_logins).toBe(5);
  });

  it('a right password ends the row of wrong ones', async () => {
    const { app, db } = await createTestApp();
    for (let i = 0; i < 4; i += 1) await attempt(app, 'wrong');
    expect((await attempt(app, 'password123')).status).toBe(200);
    const { rows } = await db.query("SELECT failed_logins FROM users WHERE username = 'alice'");
    expect(rows[0].failed_logins).toBe(0);
    // Wrong passwords never count as a login.
    for (let i = 0; i < 4; i += 1) expect((await attempt(app, 'wrong')).status).toBe(401);
  });

  it('an unknown username counts against nobody', async () => {
    const { app } = await createTestApp();
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'x' });
      expect(res.status).toBe(401);
    }
  });

  it('the admin locks and unlocks an account, and unlocking forgets the failures', async () => {
    const { app, adminCookie, aliceCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const id = rows[0].id;
    // A device token the lock has to cut off too.
    const { accessToken } = await issueDeviceToken(db, {
      userId: id,
      clientId: 'scope',
      name: 'bench',
      scopes: 'oscilloscope',
    });
    expect(await getDeviceTokenUser(db, accessToken)).not.toBeNull();

    const lock = await request(app)
      .put(`/api/users/${id}/lock`)
      .set('Cookie', adminCookie)
      .send({ locked: true });
    expect(lock.status).toBe(200);
    expect(lock.body.locked_at).not.toBeNull();
    expect(lock.body.locked_reason).toBe('admin');
    expect((await request(app).get('/api/auth/me').set('Cookie', aliceCookie)).status).toBe(401);
    expect((await attempt(app, 'password123')).status).toBe(403);
    expect(await getDeviceTokenUser(db, accessToken)).toBeNull();

    const list = await request(app).get('/api/users').set('Cookie', adminCookie);
    expect(list.body.find((u) => u.username === 'alice').locked_reason).toBe('admin');

    await db.models.User.update({ failed_logins: 3 }, { where: { id } });
    const unlock = await request(app)
      .put(`/api/users/${id}/lock`)
      .set('Cookie', adminCookie)
      .send({ locked: false });
    expect(unlock.status).toBe(200);
    expect(unlock.body.locked_at).toBeNull();
    expect(unlock.body.failed_logins).toBe(0);
    expect((await attempt(app, 'password123')).status).toBe(200);
  });

  it('the admin cannot lock themselves, and the body has to say which way', async () => {
    const { app, adminCookie, aliceCookie, db } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'admin'");
    expect(
      (await request(app).put(`/api/users/${rows[0].id}/lock`).set('Cookie', adminCookie).send({ locked: true })).status
    ).toBe(400);
    const { rows: alice } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    expect(
      (await request(app).put(`/api/users/${alice[0].id}/lock`).set('Cookie', adminCookie).send({ locked: 'yes' })).status
    ).toBe(400);
    expect(
      (await request(app).put(`/api/users/${alice[0].id}/lock`).set('Cookie', aliceCookie).send({ locked: true })).status
    ).toBe(403);
    expect(
      (await request(app).put('/api/users/99999/lock').set('Cookie', adminCookie).send({ locked: true })).status
    ).toBe(404);
  });
});
