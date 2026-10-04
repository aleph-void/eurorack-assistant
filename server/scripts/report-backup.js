// Records how a backup run ended, for ./backup-to-s3.sh:
//
//   docker compose exec -T server node scripts/report-backup.js \
//     --status failed|completed [--name <object>] [--size <bytes>] \
//     [--started <ISO time>] [--host <name>] < <log tail>
//
// The message — the tail of the run's log, which for a failure is the error
// — comes on stdin. The row lands in backup_runs (services/backups.js), which
// is what the admin's Backups page and the banner over every page read, and
// a failure (or the success that follows one) is mailed to the alert address
// from here, through the app's own mail settings, because the host has none.
//
// Exits non-zero only when the report itself could not be made: the backup's
// own outcome is the caller's to report, and this script never changes it.

import { createDatabase } from '../src/db/index.js';
import { recordBackupRun } from '../src/services/backups.js';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

const status = option('--status');
if (!status) {
  console.error('usage: report-backup.js --status failed|completed [--name N] [--size BYTES] [--started ISO] [--host H] < message');
  process.exit(2);
}

const db = createDatabase();
try {
  const message = (await readStdin()).trim();
  const { run, alert } = await recordBackupRun(db, {
    status,
    name: option('--name') || '',
    size_bytes: option('--size') ?? null,
    started_at: option('--started') || null,
    host: option('--host') || '',
    message,
  });
  console.log(`recorded backup run #${run.id} as ${run.status}`);
  if (alert) {
    console.log(alert.sent ? `alert mailed to ${alert.to}` : `alert NOT mailed: ${alert.reason}`);
  }
} catch (e) {
  console.error(`could not record the backup run: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
