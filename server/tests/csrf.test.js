import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import request from 'supertest';
import { createTestApp, createTestDb, createUser, login } from './helpers.js';
import { createApp } from '../src/app.js';
import { createBus } from '../src/events.js';
import { attachWebSocketServer } from '../src/ws.js';
import {
  crossOriginProblem,
  parseTrustedOrigins,
  upgradeOriginProblem,
} from '../src/csrf.js';

const req = (method, headers = {}) => ({ method, headers });

describe('parseTrustedOrigins', () => {
  it('parses a comma-separated list of origins down to their hosts', () => {
    const trusted = parseTrustedOrigins('https://a.example, http://b.example:8080');
    expect(trusted.has('a.example')).toBe(true);
    expect(trusted.has('b.example:8080')).toBe(true);
  });

  it('normalizes default ports and case', () => {
    const trusted = parseTrustedOrigins('https://A.Example:443');
    expect(trusted.has('a.example')).toBe(true);
  });

  it('answers an empty set for nothing configured', () => {
    expect(parseTrustedOrigins(undefined).size).toBe(0);
    expect(parseTrustedOrigins('').size).toBe(0);
  });

  it('refuses a malformed entry loudly rather than protecting nothing', () => {
    expect(() => parseTrustedOrigins('not an origin')).toThrow(/not an origin/);
  });
});

describe('crossOriginProblem', () => {
  it('never questions safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(crossOriginProblem(req(method, { 'sec-fetch-site': 'cross-site' }))).toBeNull();
    }
  });

  it('trusts the browser saying same-origin, or that no page asked at all', () => {
    expect(crossOriginProblem(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(crossOriginProblem(req('POST', { 'sec-fetch-site': 'none' }))).toBeNull();
  });

  it('refuses cross-site and same-site alike', () => {
    expect(crossOriginProblem(req('POST', { 'sec-fetch-site': 'cross-site' }))).toMatch(
      /cross-origin/
    );
    expect(crossOriginProblem(req('POST', { 'sec-fetch-site': 'same-site' }))).toMatch(
      /cross-origin/
    );
  });

  it('falls back to comparing Origin against Host', () => {
    expect(
      crossOriginProblem(req('POST', { origin: 'https://app.example', host: 'app.example' }))
    ).toBeNull();
    expect(
      crossOriginProblem(req('POST', { origin: 'https://evil.example', host: 'app.example' }))
    ).toMatch(/cross-origin/);
  });

  it('ignores the scheme but not the port', () => {
    expect(
      crossOriginProblem(req('POST', { origin: 'http://app.example', host: 'app.example' }))
    ).toBeNull();
    expect(
      crossOriginProblem(req('POST', { origin: 'https://app.example:8443', host: 'app.example' }))
    ).toMatch(/cross-origin/);
  });

  it('passes a request with no browser headers at all', () => {
    expect(crossOriginProblem(req('POST', { host: 'app.example' }))).toBeNull();
    expect(crossOriginProblem(req('DELETE', {}))).toBeNull();
  });

  it('refuses an opaque or malformed Origin', () => {
    expect(crossOriginProblem(req('POST', { origin: 'null', host: 'app.example' }))).toMatch(
      /cross-origin/
    );
    expect(crossOriginProblem(req('POST', { origin: '::::', host: 'app.example' }))).toMatch(
      /cross-origin/
    );
  });

  it('lets a trusted origin through, even labelled cross-site', () => {
    const trustedOrigins = parseTrustedOrigins('https://friend.example');
    expect(
      crossOriginProblem(
        req('POST', { origin: 'https://friend.example', 'sec-fetch-site': 'cross-site' }),
        { trustedOrigins }
      )
    ).toBeNull();
    expect(
      crossOriginProblem(
        req('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
        { trustedOrigins }
      )
    ).toMatch(/cross-origin/);
  });
});

describe('upgradeOriginProblem', () => {
  it('passes native clients (no Origin) and same-origin pages', () => {
    expect(upgradeOriginProblem(req('GET', {}))).toBeNull();
    expect(
      upgradeOriginProblem(req('GET', { origin: 'http://app.example', host: 'app.example' }))
    ).toBeNull();
    expect(
      upgradeOriginProblem(
        req('GET', { origin: 'http://app.example', host: 'proxied.internal', 'sec-fetch-site': 'same-origin' })
      )
    ).toBeNull();
  });

  it('refuses another origin, unless trusted', () => {
    expect(
      upgradeOriginProblem(req('GET', { origin: 'http://evil.example', host: 'app.example' }))
    ).toMatch(/cross-origin/);
    expect(
      upgradeOriginProblem(req('GET', { origin: 'http://evil.example', host: 'app.example' }), {
        trustedOrigins: parseTrustedOrigins('http://evil.example'),
      })
    ).toBeNull();
  });
});

describe('the API behind the middleware', () => {
  it('refuses a cross-site write even with a valid session', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'Attacker rack' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/);
  });

  it('refuses a cross-site login (login CSRF), where no token scheme could', async () => {
    const { app } = await createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Host', 'app.example')
      .send({ username: 'alice', password: 'password123' });
    expect(res.status).toBe(403);
  });

  it('serves a same-origin browser and a headerless client as before', async () => {
    const { app, aliceCookie } = await createTestApp();
    const browser = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ name: 'From the app' });
    expect(browser.status).toBe(201);
    const older = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .set('Origin', 'https://app.example')
      .set('Host', 'app.example')
      .send({ name: 'From an older browser' });
    expect(older.status).toBe(201);
    const script = await request(app)
      .post('/api/racks')
      .set('Cookie', aliceCookie)
      .send({ name: 'From a script' });
    expect(script.status).toBe(201);
  });

  it('leaves cross-site reads alone — SameSite already governs the cookie', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app)
      .get('/api/racks')
      .set('Cookie', aliceCookie)
      .set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(200);
  });

  it('honours a configured trusted origin end to end', async () => {
    const db = await createTestDb();
    const app = createApp(db, {
      rateLimit: false,
      csrf: { trustedOrigins: parseTrustedOrigins('https://friend.example') },
    });
    await createUser(db, { username: 'alice' });
    const cookie = await login(app, 'alice');
    const res = await request(app)
      .post('/api/racks')
      .set('Cookie', cookie)
      .set('Origin', 'https://friend.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'From the companion app' });
    expect(res.status).toBe(201);
  });
});

describe('the websocket handshake behind the check', () => {
  let server, wsHandle;

  afterEach(async () => {
    if (wsHandle) wsHandle.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    server = wsHandle = null;
  });

  async function listen() {
    const db = await createTestDb();
    const app = createApp(db, { rateLimit: false });
    const bus = createBus();
    server = http.createServer(app);
    wsHandle = attachWebSocketServer(server, db, bus);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    await createUser(db, { username: 'alice' });
    const cookie = await login(app, 'alice');
    return { port, cookie };
  }

  function attempt(port, cookie, headers = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { Cookie: cookie, ...headers },
    });
    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', reject);
    });
  }

  it('refuses a handshake from another origin, cookie and all', async () => {
    const { port, cookie } = await listen();
    await expect(attempt(port, cookie, { Origin: 'http://evil.example' })).rejects.toThrow(/403/);
  });

  it('accepts the app itself and native clients', async () => {
    const { port, cookie } = await listen();
    await expect(attempt(port, cookie, { Origin: `http://127.0.0.1:${port}` })).resolves.toBe(
      'open'
    );
    await expect(attempt(port, cookie)).resolves.toBe('open');
  });
});
