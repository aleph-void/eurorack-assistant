// Index tune-up, round two (020 was round one).
//
// The claim loop reads `WHERE status = 'pending' ORDER BY id` on every poll
// and the reclaim/lane checks read `WHERE status = 'running'`; heartbeat_at
// never appears in a predicate (stall detection compares it in JS). So the
// 015 index paid a rewrite on every heartbeat for a column no query uses.
// (status, id) serves the same filters and lets the claim scan walk the
// queue in order instead of sorting it.

export const description = 'indexes, round two';

export async function up({ sql }) {
  await sql`
DROP INDEX jobs_status_heartbeat_idx;
CREATE INDEX jobs_status_id_idx ON jobs (status, id);

-- The patch list (\`GET /api/patches\`, newest first) and the question scope
-- page both read a user's patches; until now that was a full-table scan over
-- everyone's patches.
CREATE INDEX patches_user_idx ON patches (user_id, id);

-- Deleting a module cascades into rack_row_modules, and shrinking a rack
-- mapping's quantity looks placements up by module; both scanned every
-- placement in every rack.
CREATE INDEX rack_row_modules_module_idx ON rack_row_modules (module_id);

-- Redundant since birth: the UNIQUE (module_id, user_id, video_id) key
-- already serves every module_id lookup as its prefix.
DROP INDEX module_videos_module_idx;
`;
}

export async function down({ createIndex, dropIndex }) {
  // Put back what the up dropped (migration 026 and migration 015 made these),
  // and take away what it made.
  await createIndex('module_videos_module_idx', 'module_videos', ['module_id']);
  await dropIndex('rack_row_modules_module_idx', 'patches_user_idx', 'jobs_status_id_idx');
  await createIndex('jobs_status_heartbeat_idx', 'jobs', ['status', 'heartbeat_at']);
}
