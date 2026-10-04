// The backups, as the app sees them.
//
// The backup itself is backup-to-s3.sh on the host, run once a day by a
// systemd timer, and nothing in this process starts or watches it. What this
// file holds is the RECORD: each run reports itself as it ends (the script
// calls scripts/report-backup.js inside the server container, which lands
// here), and from the rows the app answers the two questions an admin has —
// did the last backup work, and when did one last succeed — on its Backups
// page, in the banner over every page while the answer is bad, and in the
// email a failure sends.
//
// The alert is sent from HERE rather than from the host because the host has
// no mail: the SMTP server and the address are the admin's configuration in
// the app (app_config, via services/mail.js), and the script only knows the
// bucket. A failure is mailed once, on the run that failed; the run that
// succeeds after it is mailed too, so the admin who read the first message
// knows without logging in that the fix held.

import os from 'node:os';
import { getConfig } from './config.js';
import { sendAlertMail } from './mail.js';

export const BACKUP_STATUSES = ['completed', 'failed'];

// The tail of a log is what gets stored: a failed upload's last lines say
// what refused it, and the script already cuts its message to about this.
export const MAX_MESSAGE = 16 * 1024;
const MAX_NAME = 256;
const MAX_HOST = 256;

// How long a daily backup may go without a success before the record itself
// is the problem: two days covers a run that slipped past midnight, and not a
// timer that stopped firing.
export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

// How many runs the admin page shows. Ten days are kept in the bucket;
// thirty rows is three times that and still one screen.
export const RUNS_SHOWN = 30;

export function backupRunJson(row) {
  const { id, status, name, size_bytes, message, host, started_at, finished_at, alerted } = row.get
    ? row.get({ plain: true })
    : row;
  return {
    id,
    status,
    name,
    size_bytes: size_bytes === null || size_bytes === undefined ? null : Number(size_bytes),
    message,
    host,
    started_at,
    finished_at,
    alerted,
  };
}

const text = (value, max) => String(value ?? '').slice(0, max);

const asDate = (value) => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

// The most recent runs, newest first.
export async function latestRuns(db, limit = RUNS_SHOWN) {
  const rows = await db.models.BackupRun.findAll({
    order: [
      ['finished_at', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
  });
  return rows.map(backupRunJson);
}

// What the banner and the page lead with. `problem` is one line or null:
// the last run failed, or no run has succeeded in STALE_AFTER_MS. A
// deployment that has never reported a run has no problem — the timer is
// opted into, and a banner on an install that never asked for backups would
// be noise — which the page says in its own words.
export async function backupStatus(db, { now = Date.now() } = {}) {
  const runs = await latestRuns(db, RUNS_SHOWN);
  const latest = runs[0] || null;
  const lastCompleted = runs.find((run) => run.status === 'completed') || null;
  const lastFailed = runs.find((run) => run.status === 'failed') || null;

  let problem = null;
  if (latest?.status === 'failed') {
    problem = `The last backup failed${latest.finished_at ? ` on ${new Date(latest.finished_at).toUTCString()}` : ''}.`;
  } else if (latest && (!lastCompleted || now - new Date(lastCompleted.finished_at).getTime() > STALE_AFTER_MS)) {
    problem = lastCompleted
      ? `No backup has succeeded since ${new Date(lastCompleted.finished_at).toUTCString()}.`
      : 'No backup has ever succeeded.';
  }

  return {
    latest,
    last_completed: lastCompleted,
    last_failed: lastFailed,
    problem,
    runs,
  };
}

function failureMail(run) {
  return {
    subject: `[Eurorack Assistant] Backup FAILED${run.host ? ` on ${run.host}` : ''}`,
    text: [
      `The backup of Eurorack Assistant${run.host ? ` on ${run.host}` : ''} failed at ${new Date(run.finished_at).toUTCString()}.`,
      '',
      `Backup: ${run.name || '(no name — it failed before one was chosen)'}`,
      run.started_at ? `Started: ${new Date(run.started_at).toUTCString()}` : null,
      '',
      'What the script said:',
      '',
      run.message || '(nothing was captured)',
      '',
      'Where to look: journalctl -u eurorack-assistant-backup.service on the host, and',
      'Admin → Backups in the app. The next scheduled run will try again;',
      '`sudo systemctl start eurorack-assistant-backup.service` makes one now.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  };
}

function recoveryMail(run) {
  return {
    subject: `[Eurorack Assistant] Backup succeeded again${run.host ? ` on ${run.host}` : ''}`,
    text: [
      `A backup of Eurorack Assistant${run.host ? ` on ${run.host}` : ''} succeeded at ${new Date(run.finished_at).toUTCString()}, after the previous run had failed.`,
      '',
      `Backup: ${run.name}`,
      run.size_bytes ? `Size: ${Math.round(run.size_bytes / 1024 / 1024)} MB` : null,
      '',
      'Nothing more to do.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  };
}

// Records one run and, when it is news, mails the admin: every failure, and
// the success that ends a failure. The mail is best-effort — a backup that
// failed AND could not be announced is still a failure on record, which is
// what the banner reads — and the answer says whether it went.
export async function recordBackupRun(
  db,
  { status, name = '', size_bytes = null, message = '', host = '', started_at = null, finished_at = null },
  { sendMailImpl = null, now = () => new Date() } = {}
) {
  if (!BACKUP_STATUSES.includes(status)) {
    throw new Error(`Invalid backup status: ${status} (expected ${BACKUP_STATUSES.join(' or ')})`);
  }
  const size = size_bytes === null || size_bytes === '' ? null : Number(size_bytes);
  if (size !== null && (!Number.isInteger(size) || size < 0)) {
    throw new Error(`Invalid backup size: ${size_bytes}`);
  }

  const previous = (await latestRuns(db, 1))[0] || null;
  const row = await db.models.BackupRun.create({
    status,
    name: text(name, MAX_NAME),
    size_bytes: size,
    message: text(message, MAX_MESSAGE),
    host: text(host || os.hostname(), MAX_HOST),
    started_at: asDate(started_at),
    finished_at: asDate(finished_at) || now(),
  });
  const run = backupRunJson(row);

  let mail = null;
  if (status === 'failed') mail = failureMail(run);
  else if (previous?.status === 'failed') mail = recoveryMail(run);

  let alert = null;
  if (mail) {
    try {
      alert = await sendAlertMail(await getConfig(db), mail, { sendMailImpl });
    } catch (e) {
      alert = { sent: false, reason: e.message };
    }
    if (alert.sent) {
      await row.update({ alerted: true });
      run.alerted = true;
    }
  }
  return { run, alert };
}
