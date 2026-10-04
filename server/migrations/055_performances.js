// A performance: a video of someone playing their system, shown to everyone.
//
// Everything a user makes here is private until shared, record by record,
// with named people. A performance is the opposite kind of thing: it is a
// recording somebody PUBLISHED — the video is already on YouTube for the
// world — and what they want from this app is the room to show it in, where
// the people who know what a Maths is can watch it and say something back.
// So a performance is readable by every account from the moment it is made,
// and there is no share row to manage; the author alone edits or deletes it.
// The author may open it wider still: a PUBLIC performance is a page anyone
// with the link can watch, signed in or not — the video is already public,
// so the page about it can be — while leaving a comment stays something an
// account does, because a word under somebody's performance has to be
// somebody's word.
//
// The video is not stored, fetched or downloaded: the row keeps the
// 11-character video id (services/videos.js parses it out of whatever form
// of link was pasted, exactly as a module's tutorial videos are kept) and the
// page embeds the player from it. Nothing leaves the server on the author's
// behalf.
//
// What goes beside the video is the author's to choose. The MODULES used are
// a list of module records — the shared hardware facts, so a viewer who has
// the same module can walk straight to its page — and the PATCH is one of the
// author's own, named by id: naming it is what lets every viewer read it
// (through the performance, not through a share), and clearing it takes that
// back. The patch's name is snapshotted beside the reference, like a cable's
// ends, so a performance whose patch was deleted still says what it played;
// the reference itself is nulled by the database when the patch goes.
//
// Comments are one table: who, on which performance, said what. Removed by
// the one who wrote it, by the author of the performance it is on, or by an
// admin — the same three people who may take a comment down anywhere.

export const description = 'performances: shared YouTube videos with comments';

export async function up({ sql }) {
  await sql`
CREATE TABLE performances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  -- The canonical watch URL, rebuilt from the id; never the pasted text.
  url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  -- Readable without a session when true; every account reads it either way.
  public BOOLEAN NOT NULL DEFAULT FALSE,
  -- The patch shown beside the video, if the author chose to show one. The
  -- name stays when the patch goes, so the page can still say what it was.
  patch_id INTEGER REFERENCES patches(id) ON DELETE SET NULL,
  patch_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX performances_user_idx ON performances (user_id);
CREATE INDEX performances_patch_idx ON performances (patch_id);

-- The modules the author says were used, in the order they listed them.
CREATE TABLE performance_modules (
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (performance_id, module_id)
);

CREATE INDEX performance_modules_module_idx ON performance_modules (module_id);

CREATE TABLE performance_comments (
  id SERIAL PRIMARY KEY,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read in order under one performance; that is the only way they are read.
CREATE INDEX performance_comments_performance_idx ON performance_comments (performance_id, id);
CREATE INDEX performance_comments_user_idx ON performance_comments (user_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('performance_comments', 'performance_modules', 'performances');
}
