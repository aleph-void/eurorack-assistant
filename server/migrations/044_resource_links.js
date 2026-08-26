// The rest of the internet, filed where it belongs.
//
// A module's story is not all in its manual: it is a forum thread about the
// firmware, the maker's product page, the video of the patch you are trying
// to rebuild, the spreadsheet of somebody's calibration numbers. A patch has
// the track it ended up on; a rack has the case's build thread; a system has
// the plan you drew before you bought any of it. None of that is a document
// to store — it is an address to keep, next to the thing it is about.
//
// So a link hangs off exactly one owner: a module, a patch, a rack or a
// system. Four nullable columns rather than a (kind, id) pair, because
// that is the shape the rest of the schema already uses for "one of these"
// (captures.patch_id / module_id) and because it lets the database enforce
// the reference, cascade the delete, and keep a link off a record that has
// gone. The CHECK is what makes "exactly one" a fact rather than a habit.
//
// Links are PRIVATE, like a note or an uploaded document: a module record is
// shared between everyone who racked it, and the thread you found is yours
// until you say otherwise.

export const description = 'links attached to modules, patches, racks and systems';

export async function up({ sql }) {
  await sql`
CREATE TABLE resource_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
  rack_id INTEGER REFERENCES racks(id) ON DELETE CASCADE,
  system_id INTEGER REFERENCES systems(id) ON DELETE CASCADE,
  -- http/https only, checked before it is stored (services/resourceLinks.js).
  url TEXT NOT NULL,
  -- What to call it in the list. Defaulted from the URL's host when the user
  -- types none, so a link is never a bare row of query string.
  title TEXT,
  description TEXT,
  -- Hand order within one owner: the manual's page above the forum thread.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resource_links_one_owner CHECK (
    (CASE WHEN module_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN patch_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN rack_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN system_id IS NULL THEN 0 ELSE 1 END) = 1
  )
);

CREATE INDEX resource_links_user_idx ON resource_links (user_id);
CREATE INDEX resource_links_module_idx ON resource_links (module_id, user_id);
CREATE INDEX resource_links_patch_idx ON resource_links (patch_id, user_id);
CREATE INDEX resource_links_rack_idx ON resource_links (rack_id, user_id);
CREATE INDEX resource_links_system_idx ON resource_links (system_id, user_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('resource_links');
}
