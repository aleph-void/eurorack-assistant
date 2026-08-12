# Oscilloscope integration protocol

How an oscilloscope application (CVOsc, or anything else) links itself to a
eurorack-web server, keeps a connection open, and answers requests for waveform
images and tuner readings.

The user types the server's URL into the scope app. Everything else — pairing,
channel naming, capture — follows from that one piece of information.

- [The shape of it](#the-shape-of-it)
- [1. Linking (OAuth 2.0 device grant)](#1-linking-oauth-20-device-grant)
- [2. The WebSocket connection](#2-the-websocket-connection)
- [3. Requests the server sends](#3-requests-the-server-sends)
- [4. Channel mapping](#4-channel-mapping)
- [5. What happens to a capture](#5-what-happens-to-a-capture)
- [6. Limits and failure modes](#6-limits-and-failure-modes)
- [7. Client implementation checklist](#7-client-implementation-checklist)

---

## The shape of it

```
  scope app                     eurorack-web                    browser
      │                              │                              │
      │  POST /api/oauth/device_authorization                       │
      │─────────────────────────────►│                              │
      │  {device_code, user_code, verification_uri, interval}       │
      │◄─────────────────────────────│                              │
      │                              │   user opens /link, types    │
      │                              │◄─────── the user_code ───────│
      │  POST /api/oauth/token (poll)│                              │
      │─────────────────────────────►│                              │
      │  {access_token, refresh_token}                              │
      │◄─────────────────────────────│                              │
      │                              │                              │
      │  WS /api/devices/ws  (Bearer)│                              │
      │═════════════════════════════►│ ── device connected ────────►│
      │  {"type":"hello", channels, audio_device}                   │
      │─────────────────────────────►│                              │
      │                              │◄─── "capture this patch" ────│
      │  {"type":"request","action":"capture"}                      │
      │◄─────────────────────────────│                              │
      │  {"type":"result", image PNG + tuner readings}              │
      │─────────────────────────────►│ ── stored as a patch note ──►│
```

---

## 1. Linking (OAuth 2.0 device grant)

[RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628). The app never sees
the user's password, and the user approves the link in a browser session they
are already logged into.

Clients are seeded in the `oauth_clients` table. `cvosc` exists out of the box;
add rows for other applications. Every client is **public** — no secret, because
a desktop app cannot keep one.

### 1.1 Ask for a code pair

```http
POST /api/oauth/device_authorization
Content-Type: application/json

{ "client_id": "cvosc", "scope": "oscilloscope", "device_name": "CVOsc on STUDIO-PC" }
```

`application/x-www-form-urlencoded` works too. `scope` may be omitted to get
everything the client is registered for. `device_name` is what the user sees on
the approval screen and in their device list — say what the app is and where it
is running.

```json
{
  "device_code": "3Xk1…",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://rack.example/link",
  "verification_uri_complete": "https://rack.example/link?code=WDJB-MJHT",
  "expires_in": 600,
  "interval": 5,
  "scope": "oscilloscope"
}
```

Show `verification_uri` and `user_code`. If the app can open a browser or draw a
QR code, use `verification_uri_complete` — but always show the plain URL and
code as well, because the browser may be on a different machine.

User codes use an alphabet with no vowels and no `0/O/1/I/L`; they are 8
characters shown as `XXXX-XXXX`. Entry is case-insensitive and the dash is
optional.

### 1.2 Poll for the token

```http
POST /api/oauth/token
Content-Type: application/json

{
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "client_id": "cvosc",
  "device_code": "3Xk1…"
}
```

Until the user acts, this returns HTTP 400 with an RFC 8628 error code:

| `error`                 | Meaning                                            | What the app does          |
| ----------------------- | -------------------------------------------------- | -------------------------- |
| `authorization_pending` | Not approved yet                                    | Wait `interval`, poll again |
| `slow_down`             | Polled faster than `interval`                       | Add 5s, then poll again     |
| `access_denied`         | The user said no                                    | Stop; offer to start over   |
| `expired_token`         | The 10-minute code lifetime ran out                 | Start a new authorization   |
| `invalid_grant`         | Unknown code, or already exchanged                  | Start a new authorization   |
| `invalid_client`        | Unknown or disabled `client_id` (HTTP 401)          | Fix the configuration       |

On success:

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "…",
  "scope": "oscilloscope"
}
```

Store both tokens in the OS credential store if there is one, alongside the
server URL they belong to. The device code is single-use — it stops working the
moment it is exchanged.

### 1.3 Refresh

```http
POST /api/oauth/token
{ "grant_type": "refresh_token", "client_id": "cvosc", "refresh_token": "…" }
```

**Both** tokens rotate on every refresh: store the new refresh token or the next
refresh fails. Refresh when the access token is near expiry, and whenever a
WebSocket upgrade comes back 401.

### 1.4 Unlinking

The app can retire its own credential:

```http
POST /api/oauth/revoke
{ "token": "<access or refresh token>" }
```

The user can revoke from the web UI (`Devices` → Revoke) at any time, which also
closes any socket that token has open (close code `4003`).

---

## 2. The WebSocket connection

```
wss://rack.example/api/devices/ws
Authorization: Bearer <access_token>
```

Two alternatives for clients that cannot set headers on an upgrade:
`?access_token=<token>` in the query string, or the `Sec-WebSocket-Protocol:
bearer, <token>` pair.

A missing or invalid token gets HTTP 401; a token without the `oscilloscope`
scope gets 403.

Reconnect with backoff whenever the socket drops — the server treats a
disconnect as "that scope is gone", and the web UI greys out its patch panel.

### 2.1 Envelope

Every frame is a JSON object with a `type`. Frames the server does not
understand are ignored, so new message types are safe to add.

**Server → device**

| `type`    | When                                                     |
| --------- | -------------------------------------------------------- |
| `welcome` | Immediately after the upgrade                             |
| `request` | The user asked for something; carries `request_id`        |

**Device → server**

| `type`   | When                                                          |
| -------- | ------------------------------------------------------------- |
| `hello`  | First frame after connecting; announces the device            |
| `state`  | Any time the announced state changes                          |
| `result` | Answering a `request`; echoes its `request_id`                |
| `error`  | Failing a `request`; echoes its `request_id`                  |

### 2.2 `welcome`

```json
{
  "type": "welcome",
  "protocol": 1,
  "connection_id": 7,
  "user": { "id": 2, "username": "alice" },
  "server_time": "2026-08-12T18:00:00.000Z"
}
```

### 2.3 `hello` / `state`

Send `hello` as soon as the socket opens, and `state` whenever the audio device,
the channel list, or the channel names/types change. The two have the same body.

```json
{
  "type": "hello",
  "device_name": "CVOsc on STUDIO-PC",
  "app": "CVOsc",
  "version": "1.0.0",
  "capabilities": ["capture", "tuner", "set_labels"],
  "audio_device": {
    "id": "wasapi:{0.0.1.00000000}.{…}",
    "name": "ES-9 (Expert Sleepers)",
    "channel_count": 8,
    "sample_rate": 48000
  },
  "channels": [
    {
      "index": 0,
      "name": "CH 1",
      "signal_type": "audio",
      "selected": true,
      "vertical_range": 2.0,
      "vertical_offset": 0.0,
      "time_base": 0.02
    }
  ]
}
```

`audio_device.name` is what the automatic channel mapping matches against the
modules in the patch, so report the interface's name as the OS gives it —
"ES-9" somewhere in the string is what makes the mapping work without the user
doing anything.

`signal_type` is `"audio"` or `"cv"`, lowercase, matching CVOsc's wire format.

### 2.4 `result` / `error`

```json
{ "type": "result", "request_id": "r12", "payload": { … } }
{ "type": "error",  "request_id": "r12", "error": "tuner is not enabled" }
```

Answer every request, including ones the app cannot satisfy — an `error` frame
becomes a clear message in the browser, whereas silence becomes a 30-second
timeout.

---

## 3. Requests the server sends

```json
{ "type": "request", "request_id": "r12", "action": "capture", "params": { … } }
```

### 3.1 `capture`

Render the requested channels and read the tuner at the same moment.

```json
{
  "channels": [
    { "index": 0, "label": "Make Noise Maths — EOR", "signal_type": "cv" },
    { "index": 1, "label": "Input 2 (unpatched)", "signal_type": "audio" }
  ],
  "include_tuner": true,
  "image": { "width": 1280, "height": 720 }
}
```

`image.width`/`height` may be absent — render at whatever size is natural. The
`label` and `signal_type` are what the patch says the channel is; use the label
in the pane if you draw one.

Answer with one image containing the requested channels as panes **in the order
they were requested**, plus a per-channel reading:

```json
{
  "image": { "format": "png", "data": "<base64>", "width": 1280, "height": 720 },
  "captured_at": "2026-08-12T18:00:00Z",
  "sample_rate": 48000,
  "channels": [
    {
      "index": 0,
      "signal_type": "cv",
      "vertical_range": 20.0,
      "vertical_offset": 0.0,
      "time_base": 1.0,
      "tuning": { "note": "A2", "midi": 45, "cents": -3.5, "voltage": 1.75 }
    },
    {
      "index": 1,
      "signal_type": "audio",
      "vertical_range": 2.0,
      "time_base": 0.02,
      "tuning": { "note": "A4", "midi": 69, "cents": -12.5, "frequency": 436.8, "confidence": 0.91 }
    }
  ]
}
```

- `format` must be `png`.
- `tuning` may be omitted (or its fields left out) when the detector did not lock
  on. `note_name`/`midi_note`/`frequency`/`hz`/`volts` are accepted as aliases of
  `note`/`midi`/`frequency`/`voltage`.
- `confidence` is the audio autocorrelation confidence in `[0..1]`; `voltage` is
  the mean CV voltage. Send whichever applies.
- The readings are stored as numbers and shown as text, so they survive even
  where the image cannot be read.

### 3.2 `tuner`

A live reading with no image, for the "Read tuner now" button.

```json
{ "channels": [0, 1] }
```

Answer with `{ "channels": [ { "index": 0, "tuning": { … } }, … ] }`.

### 3.3 `set_labels`

Sent after a channel mapping is worked out, so the panes on the bench read the
same as the ones on screen.

```json
{ "channels": [ { "index": 1, "label": "Make Noise Maths — EOR", "signal_type": "cv" } ] }
```

Answer `{}`. Applying the label to the pane is optional but strongly
recommended; ignoring the signal type is fine if the user has set it by hand.

---

## 4. Channel mapping

The server works out what each scope channel is watching from the patch itself:

1. Find the module instance in the patch that **is** the audio interface —
   `audio_device.name` matched against the patch's modules, or (when the device
   name is generic) the only interface-looking module in the patch.
2. Take that module's numbered input jacks in panel order — the largest group of
   same-named numbered jacks, so an ES-9's "Input 1".."Input 8" are used and its
   headphone jack is not.
3. Map scope channel *N* to input jack *N*.
4. Follow each jack backwards through the patch's cables (and any active
   normalled connection) to whatever is feeding it, which becomes the channel's
   label: `Make Noise Maths — EOR`.
5. Guess `signal_type` from the source jack's name (gates, envelopes, clocks and
   V/oct read as `cv`; everything else as `audio`).

The user can override any channel in the web UI; a hand-set channel is never
overwritten by a later automatic mapping.

Nothing about this is required of the client — it only has to report its audio
device and channel list accurately.

---

## 5. What happens to a capture

The image is stored content-addressed (sha256 of the PNG) under `CAPTURES_DIR`,
the readings become `capture_channels` rows, and both are filed under a **note
attached to the patch**. That note is what the user reads on the patch page, and
what can be attached to a question afterwards — at which point the LLM gets the
image *and* a text document spelling out every reading in it, so an answer never
depends on the model being able to open a PNG.

---

## 6. Limits and failure modes

| Limit                        | Value      | What happens past it                          |
| ---------------------------- | ---------- | --------------------------------------------- |
| WebSocket frame              | 12 MB      | The socket is closed                          |
| Capture image                | 8 MB       | HTTP 502 to the browser, capture discarded    |
| Request answer               | 30 s       | HTTP 504 to the browser, late answer ignored  |
| Device code lifetime         | 10 min     | `expired_token`                               |
| Access token lifetime        | 24 h       | Refresh                                       |

Keep captured images well under the cap — a 1280×720 PNG of a waveform is
typically tens of kilobytes.

Anything that goes wrong on the device should come back as an `error` frame with
a sentence the user can act on ("no audio input device", "tuner needs the Tuner
entitlement"). It is shown verbatim in the browser.

---

## 7. Client implementation checklist

- [ ] Settings field for the server URL; remember it.
- [ ] Device grant: request a code pair, display code + URL, poll honouring
      `interval` and `slow_down`, store both tokens per server.
- [ ] Refresh on expiry and on a 401 upgrade; store the rotated refresh token.
- [ ] "Unlink" that calls `/api/oauth/revoke` and forgets the tokens.
- [ ] WebSocket client with reconnect-with-backoff and a bearer header.
- [ ] `hello` on connect; `state` on device/channel/name changes.
- [ ] `capture`: render the named channels to a PNG, read the tuner in the same
      pass, answer with both.
- [ ] `tuner`: answer with the current readings.
- [ ] `set_labels`: rename panes.
- [ ] Answer *every* request, with `error` when it cannot be done.
