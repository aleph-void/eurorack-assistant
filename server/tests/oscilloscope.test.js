import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import request from 'supertest';
import {
  PNG_BASE64,
  connectFakeDevice,
  createTestApp,
  createUser,
  fakeBackend,
  fakeDevice,
  insertModule,
  login,
} from './helpers.js';
import { createApp } from '../src/app.js';
import { createBus } from '../src/events.js';
import { createDeviceHub } from '../src/deviceHub.js';
import { attachWebSocketServer } from '../src/ws.js';
import {
  buildScopeChannelMap,
  findInterfaceInstance,
  orderedInputJacks,
} from '../src/services/scopeMapping.js';
import { parseCaptureResult, tuningLabel } from '../src/services/captures.js';
import {
  MAX_VIDEO_BYTES,
  clampClipDuration,
  parseClipResult,
} from '../src/services/clips.js';
import { answerQuestion } from '../src/services/ask.js';
import {
  DEVICE_CODE_GRANT,
  createDeviceAuthorization,
  claimDeviceToken,
  getDeviceTokenUser,
  issueDeviceToken,
} from '../src/services/deviceAuth.js';

// Fixture: alice's rack holds an ES-9 (8 numbered inputs plus a headphone
// jack that must NOT be mistaken for one) and a Maths whose EOR is patched
// into ES-9 input 2.
async function withScopeFixture() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query(
    'SELECT id, username FROM users ORDER BY id',
  );
  fixture.alice = users.find((u) => u.username === 'alice');

  fixture.es9 = await insertModule(db, fixture.alice.id, {
    manufacturer: 'Expert Sleepers',
    name: 'ES-9',
  });
  const inputs = [];
  for (let i = 1; i <= 8; i++) inputs.push(`($1, 'input_jack', 'Input ${i}')`);
  const { rows: es9Components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ${inputs.join(',')}, ($1, 'output_jack', 'Output 1'), ($1, 'input_jack', 'Headphones')
     RETURNING *`,
    [fixture.es9.id],
  );
  fixture.es9Components = es9Components;

  fixture.maths = await insertModule(db, fixture.alice.id, {
    manufacturer: 'Make Noise',
    name: 'Maths',
  });
  const { rows: mathsComponents } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'input_jack', 'Signal In'), ($1, 'output_jack', 'EOR') RETURNING *`,
    [fixture.maths.id],
  );
  fixture.mathsOut = mathsComponents.find((c) => c.name === 'EOR');

  const { rows: racks } = await db.query(
    'SELECT id FROM racks WHERE user_id = $1',
    [fixture.alice.id],
  );
  const created = await request(fixture.app)
    .post('/api/patches')
    .set('Cookie', fixture.aliceCookie)
    .send({ rack_id: racks[0].id, name: 'Krell' });
  fixture.patch = created.body;

  const detail = await request(fixture.app)
    .get(`/api/patches/${fixture.patch.id}`)
    .set('Cookie', fixture.aliceCookie);
  fixture.detail = detail.body;
  fixture.es9Instance = detail.body.modules.find(
    (m) => m.module_name === 'ES-9',
  );
  fixture.mathsInstance = detail.body.modules.find(
    (m) => m.module_name === 'Maths',
  );

  // Maths EOR -> ES-9 Input 2, so scope channel 2 is showing the EOR.
  const input2 = fixture.es9Components.find((c) => c.name === 'Input 2');
  await request(fixture.app)
    .post(`/api/patches/${fixture.patch.id}/cables`)
    .set('Cookie', fixture.aliceCookie)
    .send({
      from_patch_module_id: fixture.mathsInstance.id,
      from_component_id: fixture.mathsOut.id,
      to_patch_module_id: fixture.es9Instance.id,
      to_component_id: input2.id,
    });
  return fixture;
}

const DEVICE_STATE = {
  app: 'CVOsc',
  version: '1.0',
  audio_device: {
    id: 'wasapi:es9',
    name: 'ES-9 (Expert Sleepers)',
    channel_count: 8,
    sample_rate: 48000,
  },
  channels: Array.from({ length: 8 }, (_, i) => ({
    index: i,
    name: `CH ${i + 1}`,
    signal_type: 'audio',
  })),
};

// A minimal EBML/webm header plus padding — enough for the format sniff.
const WEBM_BASE64 = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(20, 1),
]).toString('base64');

const recordAnswer = (params) => ({
  video: {
    format: 'webm',
    data: WEBM_BASE64,
    width: 640,
    height: 360,
    duration_seconds: params.duration_seconds,
  },
  captured_at: '2026-08-12T18:00:00Z',
  sample_rate: 48000,
  channels: (params.channels || []).map((c) => ({
    index: c.index,
    signal_type: c.index === 1 ? 'cv' : 'audio',
  })),
});

const captureAnswer = (params) => ({
  image: { format: 'png', data: PNG_BASE64, width: 640, height: 480 },
  captured_at: '2026-08-12T18:00:00Z',
  sample_rate: 48000,
  channels: (params.channels || []).map((c) => ({
    index: c.index,
    signal_type: c.index === 1 ? 'cv' : 'audio',
    vertical_range: 10,
    time_base: 0.02,
    tuning:
      c.index === 1
        ? { voltage: 1.75, note: 'A2', midi: 45, cents: 0 }
        : {
            note: 'A4',
            midi: 69,
            cents: -12.5,
            frequency: 436.8,
            confidence: 0.91,
          },
  })),
});

describe('device authorization grant', () => {
  it('walks an application from a code pair to a token', async () => {
    const { app, aliceCookie } = await createTestApp();

    const start = await request(app)
      .post('/api/oauth/device_authorization')
      .send({ client_id: 'cvosc', device_name: 'CVOsc on STUDIO-PC' });
    expect(start.status).toBe(200);
    expect(start.body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.body.verification_uri).toMatch(/\/link$/);
    expect(start.body.verification_uri_complete).toContain(
      start.body.user_code,
    );
    expect(start.body.interval).toBe(5);

    // Polling before approval keeps the app waiting.
    const pending = await request(app).post('/api/oauth/token').send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: 'cvosc',
      device_code: start.body.device_code,
    });
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe('authorization_pending');

    // Polling again immediately is too fast.
    const fast = await request(app).post('/api/oauth/token').send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: 'cvosc',
      device_code: start.body.device_code,
    });
    expect(fast.body.error).toBe('slow_down');

    // The user sees what they are approving, then approves it.
    const lookup = await request(app)
      .get(`/api/devices/authorizations/${start.body.user_code.toLowerCase()}`)
      .set('Cookie', aliceCookie);
    expect(lookup.status).toBe(200);
    expect(lookup.body.client_name).toBe('CVOsc oscilloscope');
    expect(lookup.body.device_name).toBe('CVOsc on STUDIO-PC');

    const approve = await request(app)
      .post(`/api/devices/authorizations/${start.body.user_code}/approve`)
      .set('Cookie', aliceCookie)
      .send({ name: 'Bench scope' });
    expect(approve.status).toBe(200);

    const token = await request(app).post('/api/oauth/token').send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: 'cvosc',
      device_code: start.body.device_code,
    });
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe('Bearer');
    expect(token.body.access_token).toBeTruthy();
    expect(token.body.scope).toBe('oscilloscope');

    // The device code is spent.
    const reuse = await request(app).post('/api/oauth/token').send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: 'cvosc',
      device_code: start.body.device_code,
    });
    expect(reuse.body.error).toBe('invalid_grant');

    const listed = await request(app)
      .get('/api/devices')
      .set('Cookie', aliceCookie);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe('Bench scope');
  });

  it('refuses unknown clients, denied codes and other users’ codes', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    await createUser(db, { username: 'bob' });
    const bobCookie = await login(app, 'bob');

    const unknown = await request(app)
      .post('/api/oauth/device_authorization')
      .send({ client_id: 'nope' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('invalid_client');

    const start = await request(app)
      .post('/api/oauth/device_authorization')
      .send({ client_id: 'cvosc' });

    // Any logged-in user may claim a code they are holding — that is what the
    // short code is for — but a denial is final for the app.
    await request(app)
      .post(`/api/devices/authorizations/${start.body.user_code}/deny`)
      .set('Cookie', bobCookie)
      .send({});
    const denied = await request(app).post('/api/oauth/token').send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: 'cvosc',
      device_code: start.body.device_code,
    });
    expect(denied.body.error).toBe('access_denied');

    // A decided code is no longer offered for approval.
    const lookup = await request(app)
      .get(`/api/devices/authorizations/${start.body.user_code}`)
      .set('Cookie', aliceCookie);
    expect(lookup.status).toBe(404);
  });

  it('expires device codes and rejects tokens after revocation', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query(
      "SELECT id FROM users WHERE username = 'alice'",
    );

    // A code older than its lifetime is dead even if it was approved.
    const { authorization, deviceCode } = await createDeviceAuthorization(db, {
      clientId: 'cvosc',
      scopes: 'oscilloscope',
      now: Date.now() - 60 * 60 * 1000,
    });
    await authorization.update({ status: 'approved', user_id: users[0].id });
    const expired = await claimDeviceToken(db, {
      deviceCode,
      clientId: 'cvosc',
    });
    expect(expired.error).toBe('expired_token');

    const { accessToken, token } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: 'cvosc',
      name: 'Bench scope',
      scopes: 'oscilloscope',
    });
    expect(await getDeviceTokenUser(db, accessToken)).not.toBeNull();

    await request(app)
      .delete(`/api/devices/${token.id}`)
      .set('Cookie', aliceCookie);
    expect(await getDeviceTokenUser(db, accessToken)).toBeNull();
  });

  it('refreshes and rotates both halves of the credential', async () => {
    const { app, db } = await createTestApp();
    const { rows: users } = await db.query(
      "SELECT id FROM users WHERE username = 'alice'",
    );
    const { refreshToken } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: 'cvosc',
      name: 'Bench scope',
      scopes: 'oscilloscope',
    });

    const refreshed = await request(app)
      .post('/api/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: 'cvosc',
        refresh_token: refreshToken,
      });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);

    // The old refresh token is gone.
    const reuse = await request(app)
      .post('/api/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: 'cvosc',
        refresh_token: refreshToken,
      });
    expect(reuse.body.error).toBe('invalid_grant');
  });
});

describe('device websocket', () => {
  it('authenticates with a bearer token and relays presence to the browser', async () => {
    const db = (await createTestApp()).db;
    const bus = createBus();
    const hub = createDeviceHub({ bus });
    const app = createApp(db, { rateLimit: false, hub });
    const server = http.createServer(app);
    const handle = attachWebSocketServer(server, db, bus, { hub });
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();

    const { rows: users } = await db.query(
      "SELECT id FROM users WHERE username = 'alice'",
    );
    const { accessToken } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: 'cvosc',
      name: 'Bench scope',
      scopes: 'oscilloscope',
    });
    const aliceCookie = await login(app, 'alice');

    try {
      // An unauthenticated device socket is refused.
      const anonymous = new WebSocket(`ws://127.0.0.1:${port}/api/devices/ws`);
      await expect(
        new Promise((resolve, reject) => {
          anonymous.on('open', resolve);
          anonymous.on('error', reject);
        }),
      ).rejects.toThrow(/401/);

      // The browser socket is listening for device presence.
      const browser = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { Cookie: aliceCookie },
      });
      const browserEvents = [];
      browser.on('message', (data) =>
        browserEvents.push(JSON.parse(data.toString())),
      );
      await new Promise((resolve) => browser.on('open', resolve));

      const device = new WebSocket(`ws://127.0.0.1:${port}/api/devices/ws`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const deviceFrames = [];
      device.on('message', (data) =>
        deviceFrames.push(JSON.parse(data.toString())),
      );
      await new Promise((resolve) => device.on('open', resolve));
      device.send(JSON.stringify({ type: 'hello', ...DEVICE_STATE }));

      // The device answers whatever the server asks it.
      device.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'request' && message.action === 'ping') {
          device.send(
            JSON.stringify({
              type: 'result',
              request_id: message.request_id,
              payload: { pong: true },
            }),
          );
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deviceFrames[0].type).toBe('welcome');
      expect(hub.list(users[0].id)[0].audio_device.name).toBe(
        'ES-9 (Expert Sleepers)',
      );

      const answer = await hub.request(hub.pick(users[0].id), 'ping', {});
      expect(answer.pong).toBe(true);

      const presence = browserEvents.filter((e) => e.kind === 'device');
      expect(presence.map((e) => e.event)).toContain('connected');
      expect(presence.at(-1).device.channels).toHaveLength(8);

      device.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hub.list(users[0].id)).toHaveLength(0);
      browser.close();
    } finally {
      handle.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fails a request the device never answers', async () => {
    const hub = createDeviceHub();
    const { connection } = fakeDevice(hub, { userId: 1, answers: {} });
    await expect(
      hub.request(connection, 'capture', {}, { timeoutMs: 20 }),
    ).rejects.toThrow(/did not answer/);
  });

  it('fails everything in flight when the device disconnects', async () => {
    const hub = createDeviceHub();
    const { connection } = fakeDevice(hub, { userId: 1, answers: {} });
    const inFlight = hub.request(
      connection,
      'capture',
      {},
      { timeoutMs: 5000 },
    );
    hub.unregister(connection);
    await expect(inFlight).rejects.toThrow(/disconnected/);
  });
});

describe('scope channel mapping', () => {
  const es9 = {
    id: 11,
    manufacturer: 'Expert Sleepers',
    module_name: 'ES-9',
    instance: 1,
    components: [
      { id: 1, type: 'input_jack', name: 'Input 1' },
      { id: 2, type: 'input_jack', name: 'Input 2' },
      { id: 3, type: 'input_jack', name: 'Headphones' },
      { id: 4, type: 'output_jack', name: 'Output 1' },
    ],
  };
  const maths = {
    id: 12,
    manufacturer: 'Make Noise',
    module_name: 'Maths',
    instance: 1,
    components: [{ id: 20, type: 'output_jack', name: 'EOR' }],
  };

  it('matches the interface by the audio device name', () => {
    const found = findInterfaceInstance([maths, es9], {
      name: 'ES-9 (Expert Sleepers)',
    });
    expect(found.module.id).toBe(11);
    expect(found.matched_by).toBe('device_name');
  });

  it('falls back to the only interface-looking module when the device name says nothing', () => {
    const found = findInterfaceInstance([maths, es9], {
      name: 'Speakers (Realtek High Definition)',
    });
    expect(found.module.id).toBe(11);
    expect(found.matched_by).toBe('known_interface');
  });

  it('orders the numbered inputs and leaves odd jacks out', () => {
    const jacks = orderedInputJacks(es9, 2);
    expect(jacks.map((j) => j.name)).toEqual(['Input 1', 'Input 2']);
  });

  it('names each channel after what the patch puts into it', () => {
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [
          {
            id: 1,
            from_patch_module_id: 12,
            from_component_id: 20,
            from_component_name: 'EOR',
            to_patch_module_id: 11,
            to_component_id: 2,
            to_component_name: 'Input 2',
          },
        ],
        normalizations: [],
      },
      device: { audio_device: { name: 'ES-9', channel_count: 2 } },
    });
    expect(map.matched_by).toBe('device_name');
    expect(map.channels[0].label).toBe('Input 1 (unpatched)');
    expect(map.channels[1].label).toBe('Make Noise Maths — EOR');
    // EOR is an end-of-rise gate, so the pane starts as a CV channel.
    expect(map.channels[1].signal_type).toBe('cv');
    expect(map.channels[1].component_name).toBe('Input 2');
  });

  it('follows an active normalled connection when nothing is patched', () => {
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [],
        normalizations: [
          {
            target_patch_module_id: 11,
            target_component_id: 1,
            active: true,
            signals: [
              {
                kind: 'output',
                patch_module_id: 12,
                component_id: 20,
                component_name: 'EOR',
              },
            ],
          },
        ],
      },
      device: { audio_device: { name: 'ES-9', channel_count: 1 } },
    });
    expect(map.channels[0].label).toBe('Make Noise Maths — EOR (normalled)');
  });

  it('follows a normalled connection that comes from a cable further back', () => {
    // The jack is fed by a normal whose source is itself the far end of a
    // patch cable, so the label names where the signal really comes from.
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [],
        normalizations: [
          {
            target_patch_module_id: 11,
            target_component_id: 1,
            active: true,
            signals: [
              { kind: 'none' },
              {
                kind: 'cable',
                from_patch_module_id: 12,
                from_component_id: 20,
                from_component_name: 'EOR',
              },
            ],
          },
        ],
      },
      device: { audio_device: { name: 'ES-9', channel_count: 1 } },
    });
    expect(map.channels[0].label).toBe('Make Noise Maths — EOR (normalled)');
    expect(map.channels[0].source_patch_module_id).toBe(12);
    expect(map.channels[0].signal_type).toBe('cv');
  });

  it('names a normal that comes from inside the module rather than a jack', () => {
    // An INTERNAL normal — the module's own oscillator feeding its own filter
    // — has no source jack to point at, so the channel carries the label and
    // no source ids.
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [],
        normalizations: [
          {
            target_patch_module_id: 11,
            target_component_id: 1,
            active: true,
            signals: [{ kind: 'internal', label: 'internal VCO' }],
          },
        ],
      },
      device: { audio_device: { name: 'ES-9', channel_count: 1 } },
    });
    expect(map.channels[0].label).toBe('internal VCO (normalled)');
    expect(map.channels[0].source_patch_module_id).toBeNull();
    expect(map.channels[0].source_component_id).toBeNull();
    expect(map.channels[0].signal_type).toBe('audio');
  });

  it('leaves scope channels past the interface\'s inputs unmapped', () => {
    // Eight channels of scope against a two-input interface: the extras get a
    // pane each with nothing in it rather than an invented jack.
    const map = buildScopeChannelMap({
      detail: { modules: [es9, maths], cables: [], normalizations: [] },
      device: { audio_device: { name: 'ES-9', channel_count: 4 } },
    });
    expect(map.channels).toHaveLength(4);
    expect(map.channels[2]).toMatchObject({
      channel_index: 2,
      patch_module_id: null,
      component_id: null,
      component_name: null,
      label: null,
      signal_type: null,
      source_description: null,
    });
    expect(map.channels[3].component_id).toBeNull();
  });

  it('ignores a normal that is not switched on', () => {
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [],
        normalizations: [
          {
            target_patch_module_id: 11,
            target_component_id: 1,
            active: false,
            signals: [
              { kind: 'output', patch_module_id: 12, component_id: 20, component_name: 'EOR' },
            ],
          },
        ],
      },
      device: { audio_device: { name: 'ES-9', channel_count: 1 } },
    });
    expect(map.channels[0].label).toBe('Input 1 (unpatched)');
  });

  it('maps nothing when the patch holds no interface', () => {
    const map = buildScopeChannelMap({
      detail: { modules: [maths], cables: [], normalizations: [] },
      device: { audio_device: { name: 'Some USB thing', channel_count: 2 } },
    });
    expect(map.matched_by).toBe('none');
    expect(map.channels).toHaveLength(0);
  });
});

describe('capture parsing', () => {
  it('rejects payloads that are not a PNG', () => {
    expect(() =>
      parseCaptureResult({ image: { format: 'jpeg', data: 'x' } }),
    ).toThrow(/png/);
    expect(() => parseCaptureResult({})).toThrow(/no image data/);
    expect(() =>
      parseCaptureResult({
        image: { data: Buffer.from('not an image').toString('base64') },
      }),
    ).toThrow(/not a PNG/);
  });

  it('accepts either spelling of the tuner fields', () => {
    const parsed = parseCaptureResult({
      image: { data: PNG_BASE64 },
      channels: [{ index: 0, tuning: { note: 'A4', midi: 69, cents: 4 } }],
    });
    expect(parsed.channels[0].note_name).toBe('A4');
    expect(parsed.channels[0].midi_note).toBe(69);
    expect(tuningLabel(parsed.channels[0])).toContain('A4 +4¢');
  });
});

describe('clip parsing', () => {
  it('sniffs the container and refuses anything that is not webm or mp4', () => {
    expect(() => parseClipResult({})).toThrow(/no video data/);
    expect(() =>
      parseClipResult({ video: { format: 'avi', data: WEBM_BASE64 } }),
    ).toThrow(/unsupported video format/);
    expect(() =>
      parseClipResult({
        video: { data: Buffer.from('not a video at all').toString('base64') },
      }),
    ).toThrow(/not webm or mp4/);
    // A container mislabeled by the device would be stored under the wrong
    // extension forever, so the bytes win and the mismatch is refused.
    expect(() =>
      parseClipResult({ video: { format: 'mp4', data: WEBM_BASE64 } }),
    ).toThrow(/declared 'mp4'/);
    // Base64 that decodes to nothing is an empty video, not a crash.
    expect(() => parseClipResult({ video: { data: '!!!' } })).toThrow(
      /empty video/,
    );
    // A video past the WebSocket-frame budget is refused, not stored.
    const huge = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(MAX_VIDEO_BYTES),
    ]).toString('base64');
    expect(() => parseClipResult({ video: { data: huge } })).toThrow(
      /byte limit/,
    );
  });

  it('accepts both containers and keeps the metadata', () => {
    const webm = parseClipResult({
      video: { format: 'webm', data: WEBM_BASE64, width: 640, height: 360, duration_seconds: 5 },
      sample_rate: 48000,
    });
    expect(webm.format).toBe('webm');
    expect(webm.width).toBe(640);
    expect(webm.duration_seconds).toBe(5);

    const mp4Bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypisom'),
      Buffer.alloc(16),
    ]);
    const mp4 = parseClipResult({ video: { data: mp4Bytes.toString('base64') } });
    expect(mp4.format).toBe('mp4');
  });

  it('clamps the requested duration into the short-clip range', () => {
    expect(clampClipDuration(undefined)).toBe(10);
    expect(clampClipDuration('nonsense')).toBe(10);
    expect(clampClipDuration(0)).toBe(1);
    expect(clampClipDuration(500)).toBe(30);
    expect(clampClipDuration(7.4)).toBe(7);
  });
});

describe('scope routes', () => {
  it('maps the patch to the connected scope and pushes the labels back', async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true } },
    });

    const mapped = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(mapped.status).toBe(200);
    expect(mapped.body.matched_by).toBe('device_name');
    expect(mapped.body.interface.module_name).toBe('ES-9');
    expect(mapped.body.channels).toHaveLength(8);
    expect(mapped.body.channels[1].label).toBe('Make Noise Maths — EOR');
    expect(mapped.body.labels_pushed).toBe(true);

    const labelRequest = sent.find((m) => m.action === 'set_labels');
    expect(labelRequest.params.channels[1]).toMatchObject({
      index: 1,
      label: 'Make Noise Maths — EOR',
    });
  });

  it('keeps a hand-set channel across a re-map', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true } },
    });
    const input5 = fixture.es9Components.find((c) => c.name === 'Input 5');

    const set = await request(fixture.app)
      .put(`/api/scope/patches/${fixture.patch.id}/channels/0`)
      .set('Cookie', fixture.aliceCookie)
      .send({
        patch_module_id: fixture.es9Instance.id,
        component_id: input5.id,
      });
    expect(set.status).toBe(200);
    expect(set.body.source).toBe('manual');
    expect(set.body.label).toContain('Input 5');

    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    const state = await request(fixture.app)
      .get(`/api/scope/patches/${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    const channel0 = state.body.channels.find((c) => c.channel_index === 0);
    expect(channel0.source).toBe('manual');
    expect(channel0.component_name).toBe('Input 5');

    // Overwriting is possible, but only when asked for.
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({ overwrite: true });
    const after = await request(fixture.app)
      .get(`/api/scope/patches/${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(
      after.body.channels.find((c) => c.channel_index === 0).component_name,
    ).toBe('Input 1');
  });

  it('rejects a mapping onto a jack that is not in the patch', async () => {
    const fixture = await withScopeFixture();
    const res = await request(fixture.app)
      .put(`/api/scope/patches/${fixture.patch.id}/channels/0`)
      .set('Cookie', fixture.aliceCookie)
      .send({ patch_module_id: fixture.es9Instance.id, component_id: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not on that module/);
  });

  it('says so when no oscilloscope is connected', async () => {
    const fixture = await withScopeFixture();
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No oscilloscope/);
  });

  it('captures a waveform, files it under a patch note and serves the image', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true }, capture: captureAnswer },
    });
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});

    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set('Cookie', fixture.aliceCookie)
      .send({ title: 'Krell gate' });
    expect(captured.status).toBe(201);
    expect(captured.body.image_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.body.channels).toHaveLength(8);

    // The channel watching ES-9 input 2 carries both what it was looking at
    // and what the tuner made of it.
    const channel = captured.body.channels.find((c) => c.channel_index === 1);
    expect(channel.label).toBe('Make Noise Maths — EOR');
    expect(channel.component_name).toBe('Input 2');
    expect(channel.source_description).toBe(
      'patched from Make Noise Maths EOR',
    );
    expect(channel.voltage).toBeCloseTo(1.75);
    expect(channel.note_name).toBe('A2');

    // The image is on disk under its hash and downloadable.
    expect(
      fs.existsSync(
        path.join(fixture.capturesDir, `${captured.body.image_hash}.png`),
      ),
    ).toBe(true);
    const image = await request(fixture.app)
      .get(`/api/captures/${captured.body.id}/image`)
      .set('Cookie', fixture.aliceCookie);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');

    // It landed in the patch's notes, with the readings written out.
    const notes = await request(fixture.app)
      .get(`/api/notes?patch_id=${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(notes.body).toHaveLength(1);
    expect(notes.body[0].title).toBe('Krell gate');
    expect(notes.body[0].body).toContain('Make Noise Maths — EOR');
    expect(notes.body[0].patches[0].id).toBe(fixture.patch.id);
    expect(notes.body[0].captures[0].id).toBe(captured.body.id);
  });

  it('reports a device that answers with something unusable', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: { image: { format: 'bmp', data: PNG_BASE64 } } },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unusable capture/);
  });

  it('keeps captures and scope maps private to their owner', async () => {
    const fixture = await withScopeFixture();
    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set('Cookie', fixture.aliceCookie)
      .send({});

    for (const path of [
      `/api/captures/${captured.body.id}`,
      `/api/captures/${captured.body.id}/image`,
      `/api/scope/patches/${fixture.patch.id}`,
    ]) {
      const res = await request(fixture.app).get(path).set('Cookie', bobCookie);
      expect(res.status).toBe(404);
    }
  });

  it('deletes the image only when the last capture referencing it is gone', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const take = () =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/captures`)
        .set('Cookie', fixture.aliceCookie)
        .send({});
    const first = await take();
    const second = await take();
    const file = path.join(fixture.capturesDir, `${first.body.image_hash}.png`);
    expect(second.body.image_hash).toBe(first.body.image_hash);

    await request(fixture.app)
      .delete(`/api/captures/${first.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(fs.existsSync(file)).toBe(true);

    await request(fixture.app)
      .delete(`/api/captures/${second.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('lists captures newest first, filtered by patch or note', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const take = (body = {}) =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/captures`)
        .set('Cookie', fixture.aliceCookie)
        .send(body);
    const first = (await take({ title: 'one' })).body;
    const second = (await take({ title: 'two' })).body;

    const get = (query = '') =>
      request(fixture.app)
        .get(`/api/captures${query}`)
        .set('Cookie', fixture.aliceCookie);
    const all = await get();
    expect(all.status).toBe(200);
    expect(all.body.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(all.body[0].channels).toHaveLength(8);

    expect((await get(`?patch_id=${fixture.patch.id}`)).body).toHaveLength(2);
    expect((await get('?patch_id=999999')).body).toEqual([]);
    // A garbage filter matches nothing rather than everything.
    expect((await get('?patch_id=abc')).body).toEqual([]);
    // Each capture files under its own fresh note.
    const filed = await get(`?note_id=${first.note_id}`);
    expect(filed.body.map((c) => c.id)).toEqual([first.id]);

    const one = await request(fixture.app)
      .get(`/api/captures/${first.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(first.id);
    expect(one.body.channels).toHaveLength(8);
  });

  it("edits a capture's title and caption, trimming and capping them", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const captured = (
      await request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/captures`)
        .set('Cookie', fixture.aliceCookie)
        .send({ title: 'Krell gate' })
    ).body;
    const put = (body) =>
      request(fixture.app)
        .put(`/api/captures/${captured.id}`)
        .set('Cookie', fixture.aliceCookie)
        .send(body);

    const titled = await put({ title: `  ${'x'.repeat(300)}  ` });
    expect(titled.status).toBe(200);
    expect(titled.body.title).toBe('x'.repeat(200));
    expect(titled.body.channels).toHaveLength(8);

    const captioned = await put({ caption: ' the gate output ' });
    expect(captioned.body).toMatchObject({
      title: 'x'.repeat(200),
      caption: 'the gate output',
    });

    // Blank strings clear a field; an empty body changes nothing.
    const cleared = await put({ title: '   ', caption: '' });
    expect(cleared.body).toMatchObject({ title: null, caption: null });
    const noop = await put({});
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ title: null, caption: null });

    expect(
      (
        await request(fixture.app)
          .put('/api/captures/999999')
          .set('Cookie', fixture.aliceCookie)
          .send({ title: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(fixture.app)
          .delete('/api/captures/999999')
          .set('Cookie', fixture.aliceCookie)
      ).status,
    ).toBe(404);
  });

  it('404s an image that was never stored or has left the disk', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const captured = (
      await request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/captures`)
        .set('Cookie', fixture.aliceCookie)
        .send({})
    ).body;
    const image = () =>
      request(fixture.app)
        .get(`/api/captures/${captured.id}/image`)
        .set('Cookie', fixture.aliceCookie);

    // The bytes are immutable, so the browser may cache them forever.
    const ok = await image();
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );

    fs.unlinkSync(path.join(fixture.capturesDir, `${captured.image_hash}.png`));
    const gone = await image();
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatch(/image not found/);

    await fixture.db.query('UPDATE captures SET image_hash = NULL WHERE id = $1', [captured.id]);
    expect((await image()).status).toBe(404);
  });

  it('validates hand-mapped channels and forgets one on demand', async () => {
    const fixture = await withScopeFixture();
    const put = (index, body) =>
      request(fixture.app)
        .put(`/api/scope/patches/${fixture.patch.id}/channels/${index}`)
        .set('Cookie', fixture.aliceCookie)
        .send(body);

    expect(
      (
        await request(fixture.app)
          .put('/api/scope/patches/999999/channels/0')
          .set('Cookie', fixture.aliceCookie)
          .send({})
      ).status,
    ).toBe(404);
    for (const index of [-1, 'abc', '1.5']) {
      const res = await put(index, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-negative integer/);
    }
    const stranger = await put(0, { patch_module_id: 99999 });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toMatch(/not in this patch/);
    const wrongJack = await put(0, {
      patch_module_id: fixture.es9Instance.id,
      component_id: 99999,
    });
    expect(wrongJack.status).toBe(400);
    expect(wrongJack.body.error).toMatch(/not on that module/);

    // An explicit label is capped, a CV channel stays a CV channel, and a
    // channel watching nothing keeps no label at all.
    const labelled = await put(3, {
      label: 'y'.repeat(300),
      signal_type: 'cv',
    });
    expect(labelled.status).toBe(200);
    expect(labelled.body).toMatchObject({
      channel_index: 3,
      label: 'y'.repeat(200),
      signal_type: 'cv',
      source: 'manual',
    });
    expect((await put(4, {})).body.label).toBeNull();

    // A bare component name (off-rack gear) becomes the channel's own label.
    const named = await put(5, { component_name: 'Kick out' });
    expect(named.body).toMatchObject({ component_name: 'Kick out', label: 'Kick out' });

    // An instance's patch label outranks its module name in the fallback.
    await request(fixture.app)
      .put(`/api/patches/${fixture.patch.id}/modules/${fixture.es9Instance.id}`)
      .set('Cookie', fixture.aliceCookie)
      .send({ label: 'the interface' });
    const input5 = fixture.es9Components.find((c) => c.name === 'Input 5');
    const auto = await put(6, {
      patch_module_id: fixture.es9Instance.id,
      component_id: input5.id,
    });
    expect(auto.body.label).toBe('the interface — Input 5');

    const remove = (patchId, index) =>
      request(fixture.app)
        .delete(`/api/scope/patches/${patchId}/channels/${index}`)
        .set('Cookie', fixture.aliceCookie);
    expect((await remove(999999, 3)).status).toBe(404);
    expect((await remove(fixture.patch.id, 3)).status).toBe(200);
    const state = await request(fixture.app)
      .get(`/api/scope/patches/${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(state.body.channels.map((c) => c.channel_index).sort()).toEqual([4, 5, 6]);
  });

  it('pushes stored labels on demand and reads the live tuner', async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: {
        set_labels: { ok: true },
        tuner: (params) => ({
          channels: params.channels.map((index) => ({ index, voltage: 1.75, note: 'A2' })),
        }),
      },
    });
    const labels = () =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/labels`)
        .set('Cookie', fixture.aliceCookie)
        .send({});
    const tuner = (body = {}) =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/tuner`)
        .set('Cookie', fixture.aliceCookie)
        .send(body);

    expect(
      (
        await request(fixture.app)
          .post('/api/scope/patches/999999/labels')
          .set('Cookie', fixture.aliceCookie)
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (
        await request(fixture.app)
          .post('/api/scope/patches/999999/tuner')
          .set('Cookie', fixture.aliceCookie)
          .send({})
      ).status,
    ).toBe(404);

    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    const pushed = await labels();
    expect(pushed.status).toBe(200);
    expect(pushed.body.ok).toBe(true);
    expect(pushed.body.channels).toHaveLength(8);
    expect(sent.filter((m) => m.action === 'set_labels')).toHaveLength(2);

    // The tuner asks about the stored channels unless the caller names some.
    const live = await tuner();
    expect(live.status).toBe(200);
    expect(live.body.patch_id).toBe(fixture.patch.id);
    expect(live.body.channels).toHaveLength(8);
    const two = await tuner({ channels: [2, 5] });
    expect(two.body.channels).toEqual([
      { index: 2, voltage: 1.75, note: 'A2' },
      { index: 5, voltage: 1.75, note: 'A2' },
    ]);
  });

  it('turns a silent or failing scope into a 504 or 502-free error, not a crash', async () => {
    const fixture = await withScopeFixture();

    // No scope at all: both push endpoints say so.
    for (const action of ['labels', 'tuner']) {
      const res = await request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/${action}`)
        .set('Cookie', fixture.aliceCookie)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/No oscilloscope/);
    }

    // A scope that vanishes mid-request is a gateway problem…
    let device;
    device = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: {
        set_labels: () => {
          fixture.hub.unregister(device.connection);
          return new Promise(() => {});
        },
        // …and one that answers with an error of its own is a server fault.
        tuner: () => {
          throw new Error('the scope is busy');
        },
      },
    });
    const silent = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/labels`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(silent.status).toBe(504);
    expect(silent.body.error).toMatch(/disconnected/);

    const device2 = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: {
        tuner: () => {
          throw new Error('the scope is busy');
        },
      },
    });
    const failing = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/tuner`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(failing.status).toBe(500);
    void device2;
  });
});

describe('scope clips', () => {
  it('records a clip, attaches it to the module feeding the pane and serves the video', async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });

    const recorded = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1], duration_seconds: 8, title: 'EOR rising' });
    expect(recorded.status).toBe(201);
    // Pane 2 is showing the Maths EOR, so the clip lands on the Maths.
    expect(recorded.body.module_id).toBe(fixture.maths.id);
    expect(recorded.body.video_format).toBe('webm');
    expect(recorded.body.duration_seconds).toBe(8);
    expect(recorded.body.patch_name).toBe('Krell');
    expect(recorded.body.channels).toHaveLength(1);
    expect(recorded.body.channels[0].label).toBe('Make Noise Maths — EOR');
    expect(recorded.body.channels[0].source_description).toBe(
      'patched from Make Noise Maths EOR',
    );

    // The device was asked for exactly that pane and that duration.
    const ask = sent.find((m) => m.action === 'record');
    expect(ask.params.duration_seconds).toBe(8);
    expect(ask.params.channels).toHaveLength(1);
    expect(ask.params.channels[0].index).toBe(1);

    // The bytes are on disk under their hash and downloadable, immutable.
    const clip = await request(fixture.app)
      .get(`/api/clips/${recorded.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(clip.status).toBe(200);
    const video = await request(fixture.app)
      .get(`/api/clips/${recorded.body.id}/video`)
      .set('Cookie', fixture.aliceCookie);
    expect(video.status).toBe(200);
    expect(video.headers['content-type']).toBe('video/webm');
    expect(video.headers['cache-control']).toContain('immutable');

    // The module page shows it, and the list filters both ways.
    const module = await request(fixture.app)
      .get(`/api/modules/${fixture.maths.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(module.body.clips).toHaveLength(1);
    expect(module.body.clips[0].id).toBe(recorded.body.id);
    const byPatch = await request(fixture.app)
      .get(`/api/clips?patch_id=${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(byPatch.body).toHaveLength(1);
    const byOtherModule = await request(fixture.app)
      .get(`/api/clips?module_id=${fixture.es9.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(byOtherModule.body).toHaveLength(0);
  });

  it('honours an explicit module choice and refuses one the user does not have racked', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });

    const onEs9 = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1], module_id: fixture.es9.id });
    expect(onEs9.status).toBe(201);
    expect(onEs9.body.module_id).toBe(fixture.es9.id);

    const foreign = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1], module_id: 99999 });
    expect(foreign.status).toBe(404);
  });

  it('records every mapped or announced pane when none are named', async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });
    const recorded = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    expect(recorded.status).toBe(201);
    // No channel list in the body means all of them, exactly as a capture.
    expect(
      sent.find((m) => m.action === 'record').params.channels.map((c) => c.index),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Pane 1 is unpatched, so the fallback is the jack itself: the ES-9.
    expect(recorded.body.module_id).toBe(fixture.es9.id);
    expect(recorded.body.channels).toHaveLength(8);
  });

  it('turns a device that fails the recording into a 504, not a crash', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: {
        record: () => {
          throw new Error('a recording is already in progress');
        },
      },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1] });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/already in progress/);
  });

  it('clamps a runaway duration before asking the device', async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });
    const recorded = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1], duration_seconds: 500 });
    expect(recorded.status).toBe(201);
    expect(sent.find((m) => m.action === 'record').params.duration_seconds).toBe(30);
  });

  it('refuses cleanly when the scope does not list the record capability', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: { ...DEVICE_STATE, capabilities: ['capture', 'tuner'] },
      answers: { record: recordAnswer },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not support recording/);
  });

  it('asks for a module by name when the panes map to nothing', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });
    // A pane past the interface's inputs is mapped to no jack at all, so
    // nothing says which module the clip is about.
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [12] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/module_id/);
  });

  it('reports a device that answers with something unusable', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: { video: { format: 'webm', data: PNG_BASE64 } } },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1] });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unusable clip/);
  });

  it('keeps clips private and deletes the file only with the last reference', async () => {
    const fixture = await withScopeFixture();
    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });
    const take = () =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/clips`)
        .set('Cookie', fixture.aliceCookie)
        .send({ channels: [1] });
    const first = await take();
    const second = await take();
    expect(first.status).toBe(201);

    for (const url of [
      `/api/clips/${first.body.id}`,
      `/api/clips/${first.body.id}/video`,
    ]) {
      const res = await request(fixture.app).get(url).set('Cookie', bobCookie);
      expect(res.status).toBe(404);
    }

    // Same bytes, one file; it goes only when the last row does.
    const clip = await request(fixture.app)
      .get(`/api/clips/${first.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(clip.status).toBe(200);
    const files = () => fs.readdirSync(path.join(fixture.capturesDir, 'clips'));
    expect(files()).toHaveLength(1);

    await request(fixture.app)
      .delete(`/api/clips/${first.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(files()).toHaveLength(1);
    await request(fixture.app)
      .delete(`/api/clips/${second.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(files()).toHaveLength(0);
  });

  it("edits a clip's title and caption, trimming and capping them", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { record: recordAnswer },
    });
    const recorded = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/clips`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [1] });

    const updated = await request(fixture.app)
      .put(`/api/clips/${recorded.body.id}`)
      .set('Cookie', fixture.aliceCookie)
      .send({ title: `  ${'x'.repeat(300)}  `, caption: '  slow rise  ' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toHaveLength(200);
    expect(updated.body.caption).toBe('slow rise');
  });
});

describe('notes on patches', () => {
  it('attaches, lists and detaches a note on a patch', async () => {
    const fixture = await withScopeFixture();
    const created = await request(fixture.app)
      .post('/api/notes')
      .set('Cookie', fixture.aliceCookie)
      .send({
        title: 'Bench log',
        body: 'Rise at 3 o’clock',
        patch_ids: [fixture.patch.id],
      });
    expect(created.status).toBe(201);
    expect(created.body.patches).toEqual([
      { id: fixture.patch.id, name: 'Krell', rack_name: 'main rack' },
    ]);

    const listed = await request(fixture.app)
      .get(`/api/notes?patch_id=${fixture.patch.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(listed.body).toHaveLength(1);

    const detached = await request(fixture.app)
      .post(`/api/notes/${created.body.id}/detach`)
      .set('Cookie', fixture.aliceCookie)
      .send({ patch_id: fixture.patch.id });
    expect(detached.body.patches).toEqual([]);
    // Detaching leaves the note itself alone.
    const remaining = await request(fixture.app)
      .get('/api/notes')
      .set('Cookie', fixture.aliceCookie);
    expect(remaining.body).toHaveLength(1);
  });

  it('refuses to attach a note to someone else’s patch', async () => {
    const fixture = await withScopeFixture();
    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    const res = await request(fixture.app)
      .post('/api/notes')
      .set('Cookie', bobCookie)
      .send({ body: 'nice patch', patch_ids: [fixture.patch.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not yours/);
  });
});

describe('captures in the question flow', () => {
  it('sends an attached capture to the LLM as both an image and a written-out reading', async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set('Cookie', fixture.aliceCookie)
      .send({});
    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set('Cookie', fixture.aliceCookie)
      .send({ title: 'Krell gate' });

    const question = await fixture.db.models.Question.create({
      user_id: fixture.alice.id,
      prompt: 'Why is the gate so short?',
      status: 'pending',
    });
    await fixture.db.models.QuestionModule.create({
      question_id: question.id,
      module_id: fixture.maths.id,
    });
    await fixture.db.models.QuestionCapture.create({
      question_id: question.id,
      capture_id: captured.body.id,
    });

    const backend = fakeBackend({
      answerWithDocuments: 'Because Rise is low.',
    });
    await answerQuestion(
      fixture.db,
      backend,
      question.get({ plain: true }),
      fixture.manualsDir,
      {
        capturesDir: fixture.capturesDir,
      },
    );

    const [prompt, manuals, textDocs, imagePaths] =
      backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('oscilloscope captures of the live patch');
    expect(manuals).toEqual([]);
    expect(imagePaths).toEqual([
      path.join(fixture.capturesDir, `${captured.body.image_hash}.png`),
    ]);
    const captureDoc = textDocs.find(
      (d) => d.name === `capture-${captured.body.id}.txt`,
    );
    // Everything the picture shows is also in the text, so an answer never
    // depends on the model being able to open a PNG.
    expect(captureDoc.text).toContain('Make Noise Maths — EOR');
    expect(captureDoc.text).toContain('patched from Make Noise Maths EOR');
    expect(captureDoc.text).toContain('1.750 V');
    expect(captureDoc.text).toContain('Patch: Krell');
  }, 20000);
});
