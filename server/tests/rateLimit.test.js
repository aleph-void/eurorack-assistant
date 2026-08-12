import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestDb, createUser } from './helpers.js';
import { createApp } from '../src/app.js';
import { API_LIMIT, CREDENTIALS_LIMIT, createLimiters } from '../src/rateLimit.js';

// Each app gets its own limiter instances (and therefore its own in-memory
// counters), so tests never leak budget into one another.
async function appWithLimits(rateLimit) {
  const db = await createTestDb();
  const app = createApp(db, { rateLimit });
  await createUser(db, { username: 'alice' });
  return { app, db };
}

const wrongLogin = (app) =>
  request(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' });
const goodLogin = (app) =>
  request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });

describe('rate limiting', () => {
  it('ships sane defaults', () => {
    expect(CREDENTIALS_LIMIT.limit).toBeLessThanOrEqual(20);
    expect(CREDENTIALS_LIMIT.windowMs).toBeGreaterThanOrEqual(60_000);
    expect(API_LIMIT.limit).toBeGreaterThan(CREDENTIALS_LIMIT.limit);
  });

  it('blocks login brute force after the configured number of failures', async () => {
    const { app } = await appWithLimits({ credentials: { limit: 3, windowMs: 60_000 } });

    for (let i = 0; i < 3; i++) {
      expect((await wrongLogin(app)).status).toBe(401);
    }
    const blocked = await wrongLogin(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many failed attempts/i);

    // Still blocked even with the CORRECT password — the point of the limit.
    expect((await goodLogin(app)).status).toBe(429);
  });

  it('does not spend the credential budget on successful logins', async () => {
    const { app } = await appWithLimits({ credentials: { limit: 3, windowMs: 60_000 } });
    for (let i = 0; i < 6; i++) {
      expect((await goodLogin(app)).status).toBe(200);
    }
    // A single failure afterwards is still just the first of the three.
    expect((await wrongLogin(app)).status).toBe(401);
  });

  it('shares one budget between login and the password-change endpoint', async () => {
    const { app } = await appWithLimits({ credentials: { limit: 2, windowMs: 60_000 } });
    const cookie = (await goodLogin(app)).headers['set-cookie'][0].split(';')[0];

    expect((await wrongLogin(app)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/password')
          .set('Cookie', cookie)
          .send({ current_password: 'wrong', new_password: 'newpassword1' })
      ).status
    ).toBe(401);

    // Both endpoints drew from the same bucket, which is now empty.
    expect((await wrongLogin(app)).status).toBe(429);
  });

  it('answers JSON and standard headers when it blocks', async () => {
    const { app } = await appWithLimits({ credentials: { limit: 1, windowMs: 60_000 } });
    await wrongLogin(app);
    const blocked = await wrongLogin(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toMatch(/application\/json/);
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined(); // legacy headers off
  });

  it('caps the general API and counts successful requests too', async () => {
    const { app } = await appWithLimits({ api: { limit: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/auth/me')).status).toBe(401);
    }
    const blocked = await request(app).get('/api/auth/me');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many requests/i);
  });

  it('never rate limits the health probe', async () => {
    const { app } = await appWithLimits({ api: { limit: 1, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    // ...and the probes did not eat the API budget either.
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('can be disabled entirely for tests', async () => {
    const { app } = await appWithLimits(false);
    // An unknown username fails before the PBKDF2 verify, so this loop stays
    // cheap enough to run well past the default limit.
    for (let i = 0; i < CREDENTIALS_LIMIT.limit + 5; i++) {
      const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });
      expect(res.status).toBe(401);
    }
  });

  it('keys on the forwarded client address, not the proxy', async () => {
    // nginx sets X-Forwarded-For and createApp trusts one hop; without that,
    // one noisy client would exhaust the budget for everybody behind the proxy.
    const { app } = await appWithLimits({ credentials: { limit: 2, windowMs: 60_000 } });
    const from = (ip) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: 'alice', password: 'wrong' });

    expect((await from('203.0.113.5')).status).toBe(401);
    expect((await from('203.0.113.5')).status).toBe(401);
    expect((await from('203.0.113.5')).status).toBe(429);

    // A different client still has its own full budget.
    expect((await from('198.51.100.9')).status).toBe(401);
  });

  it('builds real limiters by default and passthroughs when disabled', () => {
    const on = createLimiters();
    expect(typeof on.credentials).toBe('function');
    expect(typeof on.api).toBe('function');
    const off = createLimiters(false);
    let called = false;
    off.credentials({}, {}, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
