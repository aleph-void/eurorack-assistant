// Short video clips recorded from the oscilloscope.
//
// A capture (migration 013) is one still image filed under a note on the
// PATCH it was taken from. A clip is the moving version of the same panes —
// a few seconds of them — and it is attached to a MODULE: "this is what the
// Maths EOR looks like doing this" belongs with the module the signal comes
// from, next to its YouTube videos, not buried in one patch's notes.
//
// The video bytes are content-addressed like capture images (sha256, stored
// at CAPTURES_DIR/clips/<hash>.<format>), so an identical clip costs one
// file. The patch reference is soft-ish (SET NULL): the clip belongs to the
// module and outlives the patch it happened to be recorded during, keeping
// the patch's name in patch_name the way patch tables keep module names.

export const description = 'oscilloscope video clips attached to modules';

export async function up({ sql }) {
  await sql`
CREATE TABLE scope_clips (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The module the clip is attached to (shown on its videos page).
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- Where it was recorded. The clip is the module's, so the patch going
  -- does not take it; the name survives as text.
  patch_id INTEGER REFERENCES patches(id) ON DELETE SET NULL,
  patch_name TEXT,
  device_token_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
  device_name TEXT,
  audio_device_id TEXT,
  audio_device_name TEXT,
  title TEXT,
  caption TEXT,
  video_hash TEXT,
  -- 'webm' or 'mp4' — also the stored file's extension.
  video_format TEXT,
  video_width INTEGER,
  video_height INTEGER,
  video_bytes INTEGER,
  duration_seconds REAL,
  sample_rate REAL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scope_clips_user_idx ON scope_clips (user_id);
CREATE INDEX scope_clips_module_idx ON scope_clips (module_id);
CREATE INDEX scope_clips_patch_idx ON scope_clips (patch_id);

-- One row per pane in the clip: what it was pointed at and where that
-- signal came from, frozen at record time so the clip still explains
-- itself after the patch changes.
CREATE TABLE scope_clip_channels (
  id SERIAL PRIMARY KEY,
  clip_id INTEGER NOT NULL REFERENCES scope_clips(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,
  label TEXT,
  signal_type TEXT,
  patch_module_id INTEGER,
  component_id INTEGER,
  component_name TEXT,
  module_label TEXT,
  source_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scope_clip_channels_clip_idx ON scope_clip_channels (clip_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('scope_clip_channels', 'scope_clips');
}
