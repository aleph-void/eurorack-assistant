// Oscilloscope integration: an external scope application (CVOsc and anything
// else speaking the protocol in docs/oscilloscope-protocol.md) links itself to
// a user account through an OAuth 2.0 device authorization grant, holds the
// connection open over a WebSocket, and answers capture requests from the web
// UI with a rendered waveform image plus the tuner readout of each channel.
//
// Applications allowed to ask for a token. A self-hosted deployment has no
// app store to register against, so clients are seeded here; every client is
// PUBLIC (no secret) because a desktop app cannot keep one, which is exactly
// why the device grant requires the user to approve the code in a browser
// session that is already authenticated.

export const description = 'oscilloscope: device grants, scope channels, captures';

export async function up({ sql }) {
  await sql`
CREATE TABLE oauth_clients (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- Space-separated scopes this client may request.
  scopes TEXT NOT NULL DEFAULT 'oscilloscope',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO oauth_clients (client_id, name, scopes)
VALUES ('cvosc', 'CVOsc oscilloscope', 'oscilloscope');

-- One in-flight device authorization: the app posts to
-- /api/oauth/device_authorization, shows the user_code, and polls the token
-- endpoint while the user approves (or denies) it in the web UI.
--
-- The device code is stored as a sha256 hash: it is a bearer credential for
-- the pending grant, and a database dump should not hand out half-finished
-- authorizations. The user_code is stored in the clear because the user has
-- to be able to look it up by typing it.
CREATE TABLE device_authorizations (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  -- What the app calls itself ("CVOsc on STUDIO-PC"), shown on the approval
  -- screen and carried onto the token so the user knows what they approved.
  device_name TEXT,
  -- pending -> approved -> claimed, or pending -> denied. Expiry is by
  -- expires_at rather than a status, so a lapsed row still explains itself.
  status TEXT NOT NULL DEFAULT 'pending',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_authorizations_status_idx ON device_authorizations (status);

-- An issued device credential. Access tokens are short-lived and refreshed;
-- both are stored as sha256 hashes (they are 32 random bytes, so a fast hash
-- is the right choice — there is nothing to brute-force but the full space).
CREATE TABLE device_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  scopes TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_tokens_user_idx ON device_tokens (user_id);

-- Notes already attach to modules and components; a patch is the third thing
-- a note can be about, and the one captured waveforms hang off.
CREATE TABLE note_patches (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, patch_id)
);

-- Which scope channel is looking at which jack of which module instance, for
-- one patch. Filled in automatically when a device connects (the audio
-- interface in the patch is matched against the device the scope reports, and
-- its input jacks are mapped in panel order), and freely overridable.
--
-- component_id is a soft reference like every other patch-scoped id: a
-- re-analysis rewrites module_components under new ids and the mapping must
-- keep naming what it named. audio_device_id records which interface the map
-- was built for; the map is per patch, so pointing a second interface at the
-- same patch replaces it.
CREATE TABLE patch_scope_channels (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,
  audio_device_id TEXT,
  patch_module_id INTEGER,
  component_id INTEGER,
  component_name TEXT,
  -- What the channel is showing, in words ("Make Noise Maths — Ch 1 out"),
  -- derived from the patch's cables and pushed back to the scope so its panes
  -- carry the same labels.
  label TEXT,
  signal_type TEXT,
  -- 'auto' (derived from the patch) or 'manual' (the user chose it); an
  -- automatic remap never overwrites a manual one.
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX patch_scope_channels_unique ON patch_scope_channels (patch_id, channel_index);

-- A waveform image (and the tuner reading taken with it) requested from the
-- scope while a patch was on the bench. The image is content-addressed like
-- manuals: sha256 of the PNG, stored at CAPTURES_DIR/<hash>.png.
CREATE TABLE captures (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
  -- The patch note this capture is filed under. Notes are the user's own
  -- writing about the patch; a capture is an attachment on one of them.
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  device_token_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
  device_name TEXT,
  audio_device_id TEXT,
  audio_device_name TEXT,
  title TEXT,
  caption TEXT,
  image_hash TEXT,
  image_width INTEGER,
  image_height INTEGER,
  image_bytes INTEGER,
  sample_rate REAL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX captures_user_idx ON captures (user_id);
CREATE INDEX captures_patch_idx ON captures (patch_id);

-- One row per pane in the captured image: what it was pointed at, how it was
-- scaled, and what the tuner made of it at that moment.
CREATE TABLE capture_channels (
  id SERIAL PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,
  label TEXT,
  signal_type TEXT,
  patch_module_id INTEGER,
  component_id INTEGER,
  component_name TEXT,
  module_label TEXT,
  -- Where the signal comes from, traced through the patch at capture time.
  source_description TEXT,
  -- Tuner readout. note_name/cents are what the scope displays; midi_note,
  -- frequency, confidence and voltage are the numbers behind it (voltage only
  -- for CV channels, confidence only for audio).
  note_name TEXT,
  midi_note INTEGER,
  cents REAL,
  frequency REAL,
  confidence REAL,
  voltage REAL,
  vertical_range REAL,
  vertical_offset REAL,
  time_base REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX capture_channels_capture_idx ON capture_channels (capture_id);

-- Captures attached to a question, alongside the existing manual / previous
-- answer / note attachments.
CREATE TABLE question_captures (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, capture_id)
);
`;
}

export async function down({ dropTable }) {
  // The seeded 'cvosc' client row goes with its table.
  await dropTable(
    'question_captures',
    'capture_channels',
    'captures',
    'patch_scope_channels',
    'note_patches',
    'device_tokens',
    'device_authorizations',
    'oauth_clients'
  );
}
