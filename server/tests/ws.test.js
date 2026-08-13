import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import request from 'supertest';
import { createTestDb, createUser, login } from './helpers.js';
import { createApp } from '../src/app.js';
import { createBus } from '../src/events.js';
import { attachWebSocketServer } from '../src/ws.js';

let db, app, bus, server, wsHandle, port;

beforeEach(async () => {
  db = await createTestDb();
  app = createApp(db, { rateLimit: false });
  bus = createBus();
  server = http.createServer(app);
  wsHandle = attachWebSocketServer(server, db, bus);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

afterEach(async () => {
  wsHandle.close();
  await new Promise((resolve) => server.close(resolve));
});

function connect(cookie) {
  return new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
    ws.once('close', (code) => reject(new Error(`closed: ${code}`)));
  });
}

describe('websocket progress', () => {
  it('rejects unauthenticated connections', async () => {
    const ws = connect(null);
    await expect(
      new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      })
    ).rejects.toThrow(/401/);
  });

  it('greets an authenticated user and forwards their events only', async () => {
    const alice = await createUser(db, { username: 'alice' });
    await createUser(db, { username: 'bob' });
    const aliceCookie = await login(app, 'alice');
    const bobCookie = await login(app, 'bob');

    const aliceWs = connect(aliceCookie);
    const bobWs = connect(bobCookie);
    const [aliceHello, bobHello] = await Promise.all([nextMessage(aliceWs), nextMessage(bobWs)]);
    expect(aliceHello.kind).toBe('hello');
    expect(bobHello.kind).toBe('hello');

    const bobMessages = [];
    bobWs.on('message', (d) => bobMessages.push(JSON.parse(d.toString())));

    const received = nextMessage(aliceWs);
    bus.publish(alice.id, {
      kind: 'job',
      event: 'progress',
      job: { id: 1, type: 'import' },
      message: 'importing 2 module(s)',
    });

    const event = await received;
    expect(event).toMatchObject({
      userId: alice.id,
      kind: 'job',
      event: 'progress',
      message: 'importing 2 module(s)',
    });
    expect(event.at).toBeDefined();

    // Give any stray broadcast a moment, then confirm bob saw nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(bobMessages).toHaveLength(0);

    aliceWs.close();
    bobWs.close();
  });

  // The job queue is shared, so its state is not addressed to anyone: one
  // user's exhausted subscription stops everybody's jobs.
  it('forwards a queue-wide event to every connected user', async () => {
    await createUser(db, { username: 'alice' });
    await createUser(db, { username: 'bob' });
    // Both cookies first: connecting before the second login would let the
    // first socket's greeting arrive before anything is listening for it.
    const aliceCookie = await login(app, 'alice');
    const bobCookie = await login(app, 'bob');
    const aliceWs = connect(aliceCookie);
    const bobWs = connect(bobCookie);
    await Promise.all([nextMessage(aliceWs), nextMessage(bobWs)]);

    const received = Promise.all([nextMessage(aliceWs), nextMessage(bobWs)]);
    bus.publishAll({ kind: 'queue', event: 'paused', paused: true, reason: 'usage limit reached' });

    for (const event of await received) {
      expect(event).toMatchObject({ kind: 'queue', event: 'paused', paused: true });
    }

    aliceWs.close();
    bobWs.close();
  });

  it('ignores non-ws paths', async () => {
    // A plain HTTP request to the API still works with the ws server attached.
    const res = await request(`http://127.0.0.1:${port}`).get('/api/health');
    expect(res.status).toBe(200);
  });
});
