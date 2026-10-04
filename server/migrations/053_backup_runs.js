// The backups, as the app sees them.
//
// The daily backup (backup-to-s3.sh, run by a systemd timer on the host) is
// the one piece of this deployment's upkeep that runs OUTSIDE the containers,
// which is also why nobody in the app knew whether it was working: a timer
// that stopped firing, a bucket whose credentials expired, a disk too full to
// stage the dump — each failed into the host's journal and nowhere else. Now
// every run, success or failure, reports itself here as it ends
// (scripts/report-backup.js), and the record is what tells the admin page
// that the last backup failed, what it said, and when one last succeeded —
// and what the alert email about a failure is written from.

export const description = 'a record of every backup run, for the admin page and the alert';

export async function up({ sql }) {
  await sql`
CREATE TABLE backup_runs (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  name TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT,
  message TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alerted BOOLEAN NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE backup_runs IS
  'one row per run of backup-to-s3.sh, reported by the script as it ends';
COMMENT ON COLUMN backup_runs.name IS
  'the object the run made (or set out to make) in the bucket';
COMMENT ON COLUMN backup_runs.message IS
  'the tail of the run''s log: the error for a failure, the summary for a success';
COMMENT ON COLUMN backup_runs.alerted IS
  'whether the alert email for this run was sent';

CREATE INDEX backup_runs_finished_idx ON backup_runs (finished_at DESC);
`;
}

export async function down({ dropTable }) {
  await dropTable('backup_runs');
}
