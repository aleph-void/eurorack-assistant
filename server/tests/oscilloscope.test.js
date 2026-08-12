import { describe, it, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";
import request from "supertest";
import {
  PNG_BASE64,
  connectFakeDevice,
  createTestApp,
  createUser,
  fakeBackend,
  fakeDevice,
  insertModule,
  login,
} from "./helpers.js";
import { createApp } from "../src/app.js";
import { createBus } from "../src/events.js";
import { createDeviceHub } from "../src/deviceHub.js";
import { attachWebSocketServer } from "../src/ws.js";
import {
  buildScopeChannelMap,
  findInterfaceInstance,
  orderedInputJacks,
} from "../src/services/scopeMapping.js";
import { parseCaptureResult, tuningLabel } from "../src/services/captures.js";
import { answerQuestion } from "../src/services/ask.js";
import {
  DEVICE_CODE_GRANT,
  createDeviceAuthorization,
  claimDeviceToken,
  getDeviceTokenUser,
  issueDeviceToken,
} from "../src/services/deviceAuth.js";

// Fixture: alice's rack holds an ES-9 (8 numbered inputs plus a headphone
// jack that must NOT be mistaken for one) and a Maths whose EOR is patched
// into ES-9 input 2.
async function withScopeFixture() {
  const fixture = await createTestApp();
  const { db } = fixture;
  const { rows: users } = await db.query(
    "SELECT id, username FROM users ORDER BY id",
  );
  fixture.alice = users.find((u) => u.username === "alice");

  fixture.es9 = await insertModule(db, fixture.alice.id, {
    manufacturer: "Expert Sleepers",
    name: "ES-9",
  });
  const inputs = [];
  for (let i = 1; i <= 8; i++) inputs.push(`($1, 'input_jack', 'Input ${i}')`);
  const { rows: es9Components } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ${inputs.join(",")}, ($1, 'output_jack', 'Output 1'), ($1, 'input_jack', 'Headphones')
     RETURNING *`,
    [fixture.es9.id],
  );
  fixture.es9Components = es9Components;

  fixture.maths = await insertModule(db, fixture.alice.id, {
    manufacturer: "Make Noise",
    name: "Maths",
  });
  const { rows: mathsComponents } = await db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES
     ($1, 'input_jack', 'Signal In'), ($1, 'output_jack', 'EOR') RETURNING *`,
    [fixture.maths.id],
  );
  fixture.mathsOut = mathsComponents.find((c) => c.name === "EOR");

  const { rows: racks } = await db.query(
    "SELECT id FROM racks WHERE user_id = $1",
    [fixture.alice.id],
  );
  const created = await request(fixture.app)
    .post("/api/patches")
    .set("Cookie", fixture.aliceCookie)
    .send({ rack_id: racks[0].id, name: "Krell" });
  fixture.patch = created.body;

  const detail = await request(fixture.app)
    .get(`/api/patches/${fixture.patch.id}`)
    .set("Cookie", fixture.aliceCookie);
  fixture.detail = detail.body;
  fixture.es9Instance = detail.body.modules.find(
    (m) => m.module_name === "ES-9",
  );
  fixture.mathsInstance = detail.body.modules.find(
    (m) => m.module_name === "Maths",
  );

  // Maths EOR -> ES-9 Input 2, so scope channel 2 is showing the EOR.
  const input2 = fixture.es9Components.find((c) => c.name === "Input 2");
  await request(fixture.app)
    .post(`/api/patches/${fixture.patch.id}/cables`)
    .set("Cookie", fixture.aliceCookie)
    .send({
      from_patch_module_id: fixture.mathsInstance.id,
      from_component_id: fixture.mathsOut.id,
      to_patch_module_id: fixture.es9Instance.id,
      to_component_id: input2.id,
    });
  return fixture;
}

const DEVICE_STATE = {
  app: "CVOsc",
  version: "1.0",
  audio_device: {
    id: "wasapi:es9",
    name: "ES-9 (Expert Sleepers)",
    channel_count: 8,
    sample_rate: 48000,
  },
  channels: Array.from({ length: 8 }, (_, i) => ({
    index: i,
    name: `CH ${i + 1}`,
    signal_type: "audio",
  })),
};

const captureAnswer = (params) => ({
  image: { format: "png", data: PNG_BASE64, width: 640, height: 480 },
  captured_at: "2026-08-12T18:00:00Z",
  sample_rate: 48000,
  channels: (params.channels || []).map((c) => ({
    index: c.index,
    signal_type: c.index === 1 ? "cv" : "audio",
    vertical_range: 10,
    time_base: 0.02,
    tuning:
      c.index === 1
        ? { voltage: 1.75, note: "A2", midi: 45, cents: 0 }
        : {
            note: "A4",
            midi: 69,
            cents: -12.5,
            frequency: 436.8,
            confidence: 0.91,
          },
  })),
});

describe("device authorization grant", () => {
  it("walks an application from a code pair to a token", async () => {
    const { app, aliceCookie } = await createTestApp();

    const start = await request(app)
      .post("/api/oauth/device_authorization")
      .send({ client_id: "cvosc", device_name: "CVOsc on STUDIO-PC" });
    expect(start.status).toBe(200);
    expect(start.body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.body.verification_uri).toMatch(/\/link$/);
    expect(start.body.verification_uri_complete).toContain(
      start.body.user_code,
    );
    expect(start.body.interval).toBe(5);

    // Polling before approval keeps the app waiting.
    const pending = await request(app).post("/api/oauth/token").send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: "cvosc",
      device_code: start.body.device_code,
    });
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");

    // Polling again immediately is too fast.
    const fast = await request(app).post("/api/oauth/token").send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: "cvosc",
      device_code: start.body.device_code,
    });
    expect(fast.body.error).toBe("slow_down");

    // The user sees what they are approving, then approves it.
    const lookup = await request(app)
      .get(`/api/devices/authorizations/${start.body.user_code.toLowerCase()}`)
      .set("Cookie", aliceCookie);
    expect(lookup.status).toBe(200);
    expect(lookup.body.client_name).toBe("CVOsc oscilloscope");
    expect(lookup.body.device_name).toBe("CVOsc on STUDIO-PC");

    const approve = await request(app)
      .post(`/api/devices/authorizations/${start.body.user_code}/approve`)
      .set("Cookie", aliceCookie)
      .send({ name: "Bench scope" });
    expect(approve.status).toBe(200);

    const token = await request(app).post("/api/oauth/token").send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: "cvosc",
      device_code: start.body.device_code,
    });
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.access_token).toBeTruthy();
    expect(token.body.scope).toBe("oscilloscope");

    // The device code is spent.
    const reuse = await request(app).post("/api/oauth/token").send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: "cvosc",
      device_code: start.body.device_code,
    });
    expect(reuse.body.error).toBe("invalid_grant");

    const listed = await request(app)
      .get("/api/devices")
      .set("Cookie", aliceCookie);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe("Bench scope");
  });

  it("refuses unknown clients, denied codes and other users’ codes", async () => {
    const { app, db, aliceCookie } = await createTestApp();
    await createUser(db, { username: "bob" });
    const bobCookie = await login(app, "bob");

    const unknown = await request(app)
      .post("/api/oauth/device_authorization")
      .send({ client_id: "nope" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_client");

    const start = await request(app)
      .post("/api/oauth/device_authorization")
      .send({ client_id: "cvosc" });

    // Any logged-in user may claim a code they are holding — that is what the
    // short code is for — but a denial is final for the app.
    await request(app)
      .post(`/api/devices/authorizations/${start.body.user_code}/deny`)
      .set("Cookie", bobCookie)
      .send({});
    const denied = await request(app).post("/api/oauth/token").send({
      grant_type: DEVICE_CODE_GRANT,
      client_id: "cvosc",
      device_code: start.body.device_code,
    });
    expect(denied.body.error).toBe("access_denied");

    // A decided code is no longer offered for approval.
    const lookup = await request(app)
      .get(`/api/devices/authorizations/${start.body.user_code}`)
      .set("Cookie", aliceCookie);
    expect(lookup.status).toBe(404);
  });

  it("expires device codes and rejects tokens after revocation", async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows: users } = await db.query(
      "SELECT id FROM users WHERE username = 'alice'",
    );

    // A code older than its lifetime is dead even if it was approved.
    const { authorization, deviceCode } = await createDeviceAuthorization(db, {
      clientId: "cvosc",
      scopes: "oscilloscope",
      now: Date.now() - 60 * 60 * 1000,
    });
    await authorization.update({ status: "approved", user_id: users[0].id });
    const expired = await claimDeviceToken(db, {
      deviceCode,
      clientId: "cvosc",
    });
    expect(expired.error).toBe("expired_token");

    const { accessToken, token } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: "cvosc",
      name: "Bench scope",
      scopes: "oscilloscope",
    });
    expect(await getDeviceTokenUser(db, accessToken)).not.toBeNull();

    await request(app)
      .delete(`/api/devices/${token.id}`)
      .set("Cookie", aliceCookie);
    expect(await getDeviceTokenUser(db, accessToken)).toBeNull();
  });

  it("refreshes and rotates both halves of the credential", async () => {
    const { app, db } = await createTestApp();
    const { rows: users } = await db.query(
      "SELECT id FROM users WHERE username = 'alice'",
    );
    const { refreshToken } = await issueDeviceToken(db, {
      userId: users[0].id,
      clientId: "cvosc",
      name: "Bench scope",
      scopes: "oscilloscope",
    });

    const refreshed = await request(app)
      .post("/api/oauth/token")
      .send({
        grant_type: "refresh_token",
        client_id: "cvosc",
        refresh_token: refreshToken,
      });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);

    // The old refresh token is gone.
    const reuse = await request(app)
      .post("/api/oauth/token")
      .send({
        grant_type: "refresh_token",
        client_id: "cvosc",
        refresh_token: refreshToken,
      });
    expect(reuse.body.error).toBe("invalid_grant");
  });
});

describe("device websocket", () => {
  it("authenticates with a bearer token and relays presence to the browser", async () => {
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
      clientId: "cvosc",
      name: "Bench scope",
      scopes: "oscilloscope",
    });
    const aliceCookie = await login(app, "alice");

    try {
      // An unauthenticated device socket is refused.
      const anonymous = new WebSocket(`ws://127.0.0.1:${port}/api/devices/ws`);
      await expect(
        new Promise((resolve, reject) => {
          anonymous.on("open", resolve);
          anonymous.on("error", reject);
        }),
      ).rejects.toThrow(/401/);

      // The browser socket is listening for device presence.
      const browser = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { Cookie: aliceCookie },
      });
      const browserEvents = [];
      browser.on("message", (data) =>
        browserEvents.push(JSON.parse(data.toString())),
      );
      await new Promise((resolve) => browser.on("open", resolve));

      const device = new WebSocket(`ws://127.0.0.1:${port}/api/devices/ws`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const deviceFrames = [];
      device.on("message", (data) =>
        deviceFrames.push(JSON.parse(data.toString())),
      );
      await new Promise((resolve) => device.on("open", resolve));
      device.send(JSON.stringify({ type: "hello", ...DEVICE_STATE }));

      // The device answers whatever the server asks it.
      device.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "request" && message.action === "ping") {
          device.send(
            JSON.stringify({
              type: "result",
              request_id: message.request_id,
              payload: { pong: true },
            }),
          );
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deviceFrames[0].type).toBe("welcome");
      expect(hub.list(users[0].id)[0].audio_device.name).toBe(
        "ES-9 (Expert Sleepers)",
      );

      const answer = await hub.request(hub.pick(users[0].id), "ping", {});
      expect(answer.pong).toBe(true);

      const presence = browserEvents.filter((e) => e.kind === "device");
      expect(presence.map((e) => e.event)).toContain("connected");
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

  it("fails a request the device never answers", async () => {
    const hub = createDeviceHub();
    const { connection } = fakeDevice(hub, { userId: 1, answers: {} });
    await expect(
      hub.request(connection, "capture", {}, { timeoutMs: 20 }),
    ).rejects.toThrow(/did not answer/);
  });

  it("fails everything in flight when the device disconnects", async () => {
    const hub = createDeviceHub();
    const { connection } = fakeDevice(hub, { userId: 1, answers: {} });
    const inFlight = hub.request(
      connection,
      "capture",
      {},
      { timeoutMs: 5000 },
    );
    hub.unregister(connection);
    await expect(inFlight).rejects.toThrow(/disconnected/);
  });
});

describe("scope channel mapping", () => {
  const es9 = {
    id: 11,
    manufacturer: "Expert Sleepers",
    module_name: "ES-9",
    instance: 1,
    components: [
      { id: 1, type: "input_jack", name: "Input 1" },
      { id: 2, type: "input_jack", name: "Input 2" },
      { id: 3, type: "input_jack", name: "Headphones" },
      { id: 4, type: "output_jack", name: "Output 1" },
    ],
  };
  const maths = {
    id: 12,
    manufacturer: "Make Noise",
    module_name: "Maths",
    instance: 1,
    components: [{ id: 20, type: "output_jack", name: "EOR" }],
  };

  it("matches the interface by the audio device name", () => {
    const found = findInterfaceInstance([maths, es9], {
      name: "ES-9 (Expert Sleepers)",
    });
    expect(found.module.id).toBe(11);
    expect(found.matched_by).toBe("device_name");
  });

  it("falls back to the only interface-looking module when the device name says nothing", () => {
    const found = findInterfaceInstance([maths, es9], {
      name: "Speakers (Realtek High Definition)",
    });
    expect(found.module.id).toBe(11);
    expect(found.matched_by).toBe("known_interface");
  });

  it("orders the numbered inputs and leaves odd jacks out", () => {
    const jacks = orderedInputJacks(es9, 2);
    expect(jacks.map((j) => j.name)).toEqual(["Input 1", "Input 2"]);
  });

  it("names each channel after what the patch puts into it", () => {
    const map = buildScopeChannelMap({
      detail: {
        modules: [es9, maths],
        cables: [
          {
            id: 1,
            from_patch_module_id: 12,
            from_component_id: 20,
            from_component_name: "EOR",
            to_patch_module_id: 11,
            to_component_id: 2,
            to_component_name: "Input 2",
          },
        ],
        normalizations: [],
      },
      device: { audio_device: { name: "ES-9", channel_count: 2 } },
    });
    expect(map.matched_by).toBe("device_name");
    expect(map.channels[0].label).toBe("Input 1 (unpatched)");
    expect(map.channels[1].label).toBe("Make Noise Maths — EOR");
    // EOR is an end-of-rise gate, so the pane starts as a CV channel.
    expect(map.channels[1].signal_type).toBe("cv");
    expect(map.channels[1].component_name).toBe("Input 2");
  });

  it("follows an active normalled connection when nothing is patched", () => {
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
                kind: "output",
                patch_module_id: 12,
                component_id: 20,
                component_name: "EOR",
              },
            ],
          },
        ],
      },
      device: { audio_device: { name: "ES-9", channel_count: 1 } },
    });
    expect(map.channels[0].label).toBe("Make Noise Maths — EOR (normalled)");
  });

  it("maps nothing when the patch holds no interface", () => {
    const map = buildScopeChannelMap({
      detail: { modules: [maths], cables: [], normalizations: [] },
      device: { audio_device: { name: "Some USB thing", channel_count: 2 } },
    });
    expect(map.matched_by).toBe("none");
    expect(map.channels).toHaveLength(0);
  });
});

describe("capture parsing", () => {
  it("rejects payloads that are not a PNG", () => {
    expect(() =>
      parseCaptureResult({ image: { format: "jpeg", data: "x" } }),
    ).toThrow(/png/);
    expect(() => parseCaptureResult({})).toThrow(/no image data/);
    expect(() =>
      parseCaptureResult({
        image: { data: Buffer.from("not an image").toString("base64") },
      }),
    ).toThrow(/not a PNG/);
  });

  it("accepts either spelling of the tuner fields", () => {
    const parsed = parseCaptureResult({
      image: { data: PNG_BASE64 },
      channels: [{ index: 0, tuning: { note: "A4", midi: 69, cents: 4 } }],
    });
    expect(parsed.channels[0].note_name).toBe("A4");
    expect(parsed.channels[0].midi_note).toBe(69);
    expect(tuningLabel(parsed.channels[0])).toContain("A4 +4¢");
  });
});

describe("scope routes", () => {
  it("maps the patch to the connected scope and pushes the labels back", async () => {
    const fixture = await withScopeFixture();
    const { sent } = await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true } },
    });

    const mapped = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({});
    expect(mapped.status).toBe(200);
    expect(mapped.body.matched_by).toBe("device_name");
    expect(mapped.body.interface.module_name).toBe("ES-9");
    expect(mapped.body.channels).toHaveLength(8);
    expect(mapped.body.channels[1].label).toBe("Make Noise Maths — EOR");
    expect(mapped.body.labels_pushed).toBe(true);

    const labelRequest = sent.find((m) => m.action === "set_labels");
    expect(labelRequest.params.channels[1]).toMatchObject({
      index: 1,
      label: "Make Noise Maths — EOR",
    });
  });

  it("keeps a hand-set channel across a re-map", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true } },
    });
    const input5 = fixture.es9Components.find((c) => c.name === "Input 5");

    const set = await request(fixture.app)
      .put(`/api/scope/patches/${fixture.patch.id}/channels/0`)
      .set("Cookie", fixture.aliceCookie)
      .send({
        patch_module_id: fixture.es9Instance.id,
        component_id: input5.id,
      });
    expect(set.status).toBe(200);
    expect(set.body.source).toBe("manual");
    expect(set.body.label).toContain("Input 5");

    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({});
    const state = await request(fixture.app)
      .get(`/api/scope/patches/${fixture.patch.id}`)
      .set("Cookie", fixture.aliceCookie);
    const channel0 = state.body.channels.find((c) => c.channel_index === 0);
    expect(channel0.source).toBe("manual");
    expect(channel0.component_name).toBe("Input 5");

    // Overwriting is possible, but only when asked for.
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({ overwrite: true });
    const after = await request(fixture.app)
      .get(`/api/scope/patches/${fixture.patch.id}`)
      .set("Cookie", fixture.aliceCookie);
    expect(
      after.body.channels.find((c) => c.channel_index === 0).component_name,
    ).toBe("Input 1");
  });

  it("rejects a mapping onto a jack that is not in the patch", async () => {
    const fixture = await withScopeFixture();
    const res = await request(fixture.app)
      .put(`/api/scope/patches/${fixture.patch.id}/channels/0`)
      .set("Cookie", fixture.aliceCookie)
      .send({ patch_module_id: fixture.es9Instance.id, component_id: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not on that module/);
  });

  it("says so when no oscilloscope is connected", async () => {
    const fixture = await withScopeFixture();
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No oscilloscope/);
  });

  it("captures a waveform, files it under a patch note and serves the image", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { set_labels: { ok: true }, capture: captureAnswer },
    });
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({});

    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set("Cookie", fixture.aliceCookie)
      .send({ title: "Krell gate" });
    expect(captured.status).toBe(201);
    expect(captured.body.image_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.body.channels).toHaveLength(8);

    // The channel watching ES-9 input 2 carries both what it was looking at
    // and what the tuner made of it.
    const channel = captured.body.channels.find((c) => c.channel_index === 1);
    expect(channel.label).toBe("Make Noise Maths — EOR");
    expect(channel.component_name).toBe("Input 2");
    expect(channel.source_description).toBe(
      "patched from Make Noise Maths EOR",
    );
    expect(channel.voltage).toBeCloseTo(1.75);
    expect(channel.note_name).toBe("A2");

    // The image is on disk under its hash and downloadable.
    expect(
      fs.existsSync(
        path.join(fixture.capturesDir, `${captured.body.image_hash}.png`),
      ),
    ).toBe(true);
    const image = await request(fixture.app)
      .get(`/api/captures/${captured.body.id}/image`)
      .set("Cookie", fixture.aliceCookie);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");

    // It landed in the patch's notes, with the readings written out.
    const notes = await request(fixture.app)
      .get(`/api/notes?patch_id=${fixture.patch.id}`)
      .set("Cookie", fixture.aliceCookie);
    expect(notes.body).toHaveLength(1);
    expect(notes.body[0].title).toBe("Krell gate");
    expect(notes.body[0].body).toContain("Make Noise Maths — EOR");
    expect(notes.body[0].patches[0].id).toBe(fixture.patch.id);
    expect(notes.body[0].captures[0].id).toBe(captured.body.id);
  });

  it("reports a device that answers with something unusable", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: { image: { format: "bmp", data: PNG_BASE64 } } },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set("Cookie", fixture.aliceCookie)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unusable capture/);
  });

  it("keeps captures and scope maps private to their owner", async () => {
    const fixture = await withScopeFixture();
    await createUser(fixture.db, { username: "bob" });
    const bobCookie = await login(fixture.app, "bob");
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set("Cookie", fixture.aliceCookie)
      .send({});

    for (const path of [
      `/api/captures/${captured.body.id}`,
      `/api/captures/${captured.body.id}/image`,
      `/api/scope/patches/${fixture.patch.id}`,
    ]) {
      const res = await request(fixture.app).get(path).set("Cookie", bobCookie);
      expect(res.status).toBe(404);
    }
  });

  it("deletes the image only when the last capture referencing it is gone", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    const take = () =>
      request(fixture.app)
        .post(`/api/scope/patches/${fixture.patch.id}/captures`)
        .set("Cookie", fixture.aliceCookie)
        .send({});
    const first = await take();
    const second = await take();
    const file = path.join(fixture.capturesDir, `${first.body.image_hash}.png`);
    expect(second.body.image_hash).toBe(first.body.image_hash);

    await request(fixture.app)
      .delete(`/api/captures/${first.body.id}`)
      .set("Cookie", fixture.aliceCookie);
    expect(fs.existsSync(file)).toBe(true);

    await request(fixture.app)
      .delete(`/api/captures/${second.body.id}`)
      .set("Cookie", fixture.aliceCookie);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("notes on patches", () => {
  it("attaches, lists and detaches a note on a patch", async () => {
    const fixture = await withScopeFixture();
    const created = await request(fixture.app)
      .post("/api/notes")
      .set("Cookie", fixture.aliceCookie)
      .send({
        title: "Bench log",
        body: "Rise at 3 o’clock",
        patch_ids: [fixture.patch.id],
      });
    expect(created.status).toBe(201);
    expect(created.body.patches).toEqual([
      { id: fixture.patch.id, name: "Krell", rack_name: "main rack" },
    ]);

    const listed = await request(fixture.app)
      .get(`/api/notes?patch_id=${fixture.patch.id}`)
      .set("Cookie", fixture.aliceCookie);
    expect(listed.body).toHaveLength(1);

    const detached = await request(fixture.app)
      .post(`/api/notes/${created.body.id}/detach`)
      .set("Cookie", fixture.aliceCookie)
      .send({ patch_id: fixture.patch.id });
    expect(detached.body.patches).toEqual([]);
    // Detaching leaves the note itself alone.
    const remaining = await request(fixture.app)
      .get("/api/notes")
      .set("Cookie", fixture.aliceCookie);
    expect(remaining.body).toHaveLength(1);
  });

  it("refuses to attach a note to someone else’s patch", async () => {
    const fixture = await withScopeFixture();
    await createUser(fixture.db, { username: "bob" });
    const bobCookie = await login(fixture.app, "bob");
    const res = await request(fixture.app)
      .post("/api/notes")
      .set("Cookie", bobCookie)
      .send({ body: "nice patch", patch_ids: [fixture.patch.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not yours/);
  });
});

describe("captures in the question flow", () => {
  it("sends an attached capture to the LLM as both an image and a written-out reading", async () => {
    const fixture = await withScopeFixture();
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: fixture.alice.id,
      state: DEVICE_STATE,
      answers: { capture: captureAnswer },
    });
    await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/automap`)
      .set("Cookie", fixture.aliceCookie)
      .send({});
    const captured = await request(fixture.app)
      .post(`/api/scope/patches/${fixture.patch.id}/captures`)
      .set("Cookie", fixture.aliceCookie)
      .send({ title: "Krell gate" });

    const question = await fixture.db.models.Question.create({
      user_id: fixture.alice.id,
      prompt: "Why is the gate so short?",
      status: "pending",
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
      answerWithDocuments: "Because Rise is low.",
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
    expect(prompt).toContain("oscilloscope captures of the live patch");
    expect(manuals).toEqual([]);
    expect(imagePaths).toEqual([
      path.join(fixture.capturesDir, `${captured.body.image_hash}.png`),
    ]);
    const captureDoc = textDocs.find(
      (d) => d.name === `capture-${captured.body.id}.txt`,
    );
    // Everything the picture shows is also in the text, so an answer never
    // depends on the model being able to open a PNG.
    expect(captureDoc.text).toContain("Make Noise Maths — EOR");
    expect(captureDoc.text).toContain("patched from Make Noise Maths EOR");
    expect(captureDoc.text).toContain("1.750 V");
    expect(captureDoc.text).toContain("Patch: Krell");
  }, 20000);
});
