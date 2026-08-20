// YouTube videos attached to a module: the link, and what the model learned
// from watching.
//
// The video itself is a work file, not a record: the download_video job
// fetches it with yt-dlp, samples frames and pulls the caption track, and the
// analyze_video job turns those into a techniques summary — after which every
// file is deleted. What stays is this row: the link, the video's metadata and
// the summary, attached to the module the techniques are about.
//
// Owned by the user who attached the link (their LLM account pays for the
// analysis, and the summary is theirs), unlike the shared auto-found manual.

export const description = 'YouTube videos attached to a module';

export async function up({ sql }) {
  await sql`
CREATE TABLE module_videos (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The 11-character YouTube video id. The canonical URL below is rebuilt
  -- from it, so nothing but a real YouTube id is ever handed to yt-dlp.
  video_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Filled in by the download job from the video's own metadata.
  title TEXT,
  channel TEXT,
  duration_seconds INTEGER,
  -- pending → downloading → downloaded → analyzing → complete / failed
  status TEXT NOT NULL DEFAULT 'pending',
  -- The techniques summary the analysis wrote (markdown).
  summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same user attaching the same video to the same module twice is a
  -- retry, not a second record.
  UNIQUE (module_id, user_id, video_id)
);

CREATE INDEX module_videos_module_idx ON module_videos (module_id);
CREATE INDEX module_videos_user_idx ON module_videos (user_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('module_videos');
}
