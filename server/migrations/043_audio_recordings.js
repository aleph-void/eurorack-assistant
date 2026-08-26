// What the rack SOUNDS like.
//
// Everything the app records about a module or a patch until now has been
// something you read (a manual, a note) or something you look at (a panel, a
// waveform capture, a clip of the scope). None of it is the thing a synth is
// actually for. "Why does this patch buzz on the low notes" is a question
// about a sound, and answering it from a cable list alone is guesswork.
//
// So a recording is a first-class attachment, on a MODULE (this is what the
// oscillator's sub output sounds like at the bench) or on a PATCH (this is
// what the patch does), and it may come from three places — an uploaded
// file, a take recorded in the browser, or a recording requested from the
// linked oscilloscope's audio interface, which is already the thing with a
// cable in it.
//
// The bytes are content-addressed exactly like capture images, clips and
// manuals — sha256, stored at CAPTURES_DIR/audio/<hash>.<format> — so the
// same take attached twice costs one file, and a row can never point at a
// name that says something the bytes do not.
//
// A recording also carries what ffmpeg measured from it (duration, sample
// rate, channel count, peak and RMS level) and the hash of a rendered
// waveform+spectrogram PNG. Those are what make a recording answerable: a
// model cannot listen to a wav, so a question with a recording attached is
// answered from the picture of it plus the numbers, the same bargain the
// oscilloscope captures already strike (services/captures.js).

export const description = 'audio recordings attached to modules and patches';

export async function up({ sql }) {
  await sql`
CREATE TABLE audio_recordings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the recording is of: EXACTLY one of these, the way a capture is of
  -- a patch or of a module and never of both. A bench take is a module's; a
  -- take made on a patch page is the patch's, and goes when the patch does,
  -- because a recording of a patch that no longer exists is a sound nothing
  -- can explain. The patch's name is snapshotted beside it all the same, so
  -- a list can say where a take came from without joining.
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
  patch_name TEXT,
  -- 'upload' (a file), 'browser' (recorded on the page) or 'device' (asked
  -- of the linked oscilloscope).
  source TEXT NOT NULL DEFAULT 'upload',
  device_token_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
  device_name TEXT,
  audio_device_id TEXT,
  audio_device_name TEXT,
  title TEXT,
  caption TEXT,
  -- The original file name, where there was one. It is what the user calls
  -- the take; the stored file is named by its hash.
  original_name TEXT,
  audio_hash TEXT,
  -- 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm' — also the extension.
  audio_format TEXT,
  audio_bytes INTEGER,
  -- Measured from the bytes by ffmpeg where it is installed, NULL where it
  -- is not: a recording is stored and played either way.
  duration_seconds REAL,
  sample_rate REAL,
  channel_count INTEGER,
  peak_dbfs REAL,
  rms_dbfs REAL,
  -- The rendered waveform + spectrogram PNG, content-addressed in the same
  -- directory. This is the part a model can actually look at.
  waveform_hash TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audio_recordings_one_owner CHECK (
    (CASE WHEN module_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN patch_id IS NULL THEN 0 ELSE 1 END) = 1
  )
);

CREATE INDEX audio_recordings_user_idx ON audio_recordings (user_id);
CREATE INDEX audio_recordings_module_idx ON audio_recordings (module_id);
CREATE INDEX audio_recordings_patch_idx ON audio_recordings (patch_id);

-- A recording attached to a question, like question_captures: the review
-- step is where one is picked, and the answer job reads exactly these.
CREATE TABLE question_audio (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  audio_id INTEGER NOT NULL REFERENCES audio_recordings(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, audio_id)
);

CREATE INDEX question_audio_audio_idx ON question_audio (audio_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('question_audio', 'audio_recordings');
}
