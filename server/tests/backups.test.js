// The record of the daily backup: what the script reports, what the admin
// reads, and the email a failure sends.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from './helpers.js';
import { backupStatus, recordBackupRun, STALE_AFTER_MS } from '../src/services/backups.js';
import { setConfig } from '../src/services/config.js';
import { looksLikeEmail, senderAddress, smtpUrlProblem } from '../src/services/mail.js';

const mailer = () => {
  const sent = [];
  return { sent, send: async (message) => void sent.push(message) };
};

const configured = (db) =>
  setConfig(db, {
    smtp_url: 'smtps://backup%40example.com:secret@smtp.example.com:465',
    alert_email: 'admin@example.com',
  });

describe('recordBackupRun', () => {
  it('records a success and mails nobody', async () => {
    const db = await createTestDb();
    await configured(db);
    const { sent, send } = mailer();
    const { run, alert } = await recordBackupRun(
      db,
      {
        status: 'completed',
        name: 'eurorack-backup-20260101-031700Z.tar',
        size_bytes: '123456',
        message: 'uploaded',
        host: 'rack',
        started_at: '2026-01-01T03:17:00Z',
      },
      { sendMailImpl: send }
    );
    expect(run.status).toBe('completed');
    expect(run.size_bytes).toBe(123456);
    expect(run.host).toBe('rack');
    expect(run.alerted).toBe(false);
    expect(alert).toBeNull();
    expect(sent).toEqual([]);
  });

  it('mails the alert address about a failure, with what the script said', async () => {
    const db = await createTestDb();
    await configured(db);
    const { sent, send } = mailer();
    const { run, alert } = await recordBackupRun(
      db,
      {
        status: 'failed',
        name: 'eurorack-backup-20260102-031700Z.tar',
        message: 'upload failed: An error occurred (AccessDenied)',
        host: 'rack',
      },
      { sendMailImpl: send }
    );
    expect(run.alerted).toBe(true);
    expect(alert).toEqual({ sent: true, to: 'admin@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('admin@example.com');
    // No smtp_from: the SMTP login is an address, so mail is from it.
    expect(sent[0].from).toBe('backup@example.com');
    expect(sent[0].subject).toMatch(/Backup FAILED on rack/);
    expect(sent[0].text).toContain('AccessDenied');
    expect(sent[0].text).toContain('eurorack-backup-20260102-031700Z.tar');
    expect(sent[0].text).toContain('journalctl -u eurorack-assistant-backup.service');
  });

  it('mails once more when a success follows a failure, and then stays quiet', async () => {
    const db = await createTestDb();
    await configured(db);
    const { sent, send } = mailer();
    const opts = { sendMailImpl: send };
    const host = 'rack';
    await recordBackupRun(db, { status: 'failed', message: 'disk full', host }, opts);
    await recordBackupRun(db, { status: 'completed', name: 'a.tar', size_bytes: 5 << 20, host }, opts);
    await recordBackupRun(db, { status: 'completed', name: 'b.tar', host }, opts);
    expect(sent.map((m) => m.subject)).toEqual([
      '[Eurorack Assistant] Backup FAILED on rack',
      '[Eurorack Assistant] Backup succeeded again on rack',
    ]);
    expect(sent[1].text).toContain('Size: 5 MB');
  });

  it('still records a failure when no mail is configured, and says why', async () => {
    const db = await createTestDb();
    const { sent, send } = mailer();
    const { run, alert } = await recordBackupRun(db, { status: 'failed', message: 'x' }, { sendMailImpl: send });
    expect(run.status).toBe('failed');
    expect(run.alerted).toBe(false);
    expect(alert.sent).toBe(false);
    expect(alert.reason).toMatch(/no SMTP server or alert address/);
    expect(sent).toEqual([]);
  });

  it('still records a failure when the mail server refuses', async () => {
    const db = await createTestDb();
    await configured(db);
    const { run, alert } = await recordBackupRun(
      db,
      { status: 'failed', message: 'x' },
      {
        sendMailImpl: async () => {
          throw new Error('535 Authentication failed');
        },
      }
    );
    expect(run.status).toBe('failed');
    expect(alert).toEqual({ sent: false, reason: '535 Authentication failed' });
  });

  it('refuses a status that is not an outcome, and a size that is not a count', async () => {
    const db = await createTestDb();
    await expect(recordBackupRun(db, { status: 'running' })).rejects.toThrow(/Invalid backup status/);
    await expect(recordBackupRun(db, { status: 'completed', size_bytes: 'big' })).rejects.toThrow(
      /Invalid backup size/
    );
  });

  it('keeps the message to a tail', async () => {
    const db = await createTestDb();
    const { run } = await recordBackupRun(db, { status: 'failed', message: 'x'.repeat(40000) });
    expect(run.message.length).toBe(16 * 1024);
  });
});

describe('backupStatus', () => {
  it('has no problem on a deployment that has never reported a run', async () => {
    const db = await createTestDb();
    const status = await backupStatus(db);
    expect(status).toMatchObject({ latest: null, last_completed: null, last_failed: null, problem: null, runs: [] });
  });

  it('names a failed last run, and clears it when the next succeeds', async () => {
    const db = await createTestDb();
    await recordBackupRun(db, { status: 'completed', name: 'a.tar' });
    await recordBackupRun(db, { status: 'failed', message: 'no space left on device' });
    let status = await backupStatus(db);
    expect(status.problem).toMatch(/The last backup failed/);
    expect(status.latest.status).toBe('failed');
    expect(status.last_completed.name).toBe('a.tar');
    expect(status.last_failed.message).toBe('no space left on device');

    await recordBackupRun(db, { status: 'completed', name: 'b.tar' });
    status = await backupStatus(db);
    expect(status.problem).toBeNull();
    expect(status.last_completed.name).toBe('b.tar');
    expect(status.runs.map((run) => run.name)).toEqual(['b.tar', '', 'a.tar']);
  });

  it('is a problem when the last success is too long ago', async () => {
    const db = await createTestDb();
    const then = new Date('2026-01-01T03:17:00Z');
    await recordBackupRun(db, { status: 'completed', name: 'a.tar' }, { now: () => then });
    expect((await backupStatus(db, { now: then.getTime() + STALE_AFTER_MS - 1 })).problem).toBeNull();
    expect((await backupStatus(db, { now: then.getTime() + STALE_AFTER_MS + 1 })).problem).toMatch(
      /No backup has succeeded since/
    );
  });
});

describe('mail helpers', () => {
  it('recognises an address', () => {
    expect(looksLikeEmail('admin@example.com')).toBe(true);
    expect(looksLikeEmail('admin')).toBe(false);
    expect(looksLikeEmail('a b@example.com')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });

  it('holds an SMTP URL to the two schemes nodemailer reads', () => {
    expect(smtpUrlProblem('')).toBeNull();
    expect(smtpUrlProblem('smtp://smtp.example.com:587')).toBeNull();
    expect(smtpUrlProblem('smtps://u:p@smtp.example.com:465')).toBeNull();
    expect(smtpUrlProblem('https://smtp.example.com')).toMatch(/unsupported scheme https/);
    expect(smtpUrlProblem('not a url')).toMatch(/not a URL/);
  });

  it('picks a sender: the configured one, else the login, else a name', () => {
    expect(senderAddress({ smtp_url: 'smtp://x', smtp_from: 'me@example.com' })).toBe('me@example.com');
    expect(senderAddress({ smtp_url: 'smtps://me%40example.com:p@h:465' })).toBe('me@example.com');
    expect(senderAddress({ smtp_url: 'smtp://user:p@h:587' })).toBe('eurorack-assistant@localhost');
  });
});

describe('backups API', () => {
  it('serves the status and the runs to the admin only', async () => {
    const { app, db, adminCookie, aliceCookie } = await createTestApp();
    await recordBackupRun(db, { status: 'failed', message: 'boom', name: 'x.tar' });
    const res = await request(app).get('/api/backups').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.problem).toMatch(/last backup failed/);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ status: 'failed', message: 'boom', name: 'x.tar' });
    expect((await request(app).get('/api/backups').set('Cookie', aliceCookie)).status).toBe(403);
    expect((await request(app).get('/api/backups')).status).toBe(401);
  });
});

describe('alert mail config', () => {
  it('saves the SMTP URL and the addresses, and refuses junk', async () => {
    const { app, adminCookie } = await createTestApp();
    const ok = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({
        smtp_url: ' smtp://u:p@smtp.example.com:587 ',
        smtp_from: 'rack@example.com',
        alert_email: 'admin@example.com',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.smtp_url).toBe('smtp://u:p@smtp.example.com:587');
    expect(ok.body.alert_email).toBe('admin@example.com');

    for (const bad of [
      { smtp_url: 'https://smtp.example.com' },
      { smtp_url: 'nonsense' },
      { smtp_from: 'rack' },
      { alert_email: 'admin at example.com' },
    ]) {
      const res = await request(app).put('/api/config').set('Cookie', adminCookie).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toMatch(new RegExp(`Invalid ${Object.keys(bad)[0]}`));
    }
    // Blank is how each is switched off.
    const off = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ smtp_url: '', smtp_from: '', alert_email: '' });
    expect(off.status).toBe(200);
    expect(off.body.smtp_url).toBe('');
  });

  it('sends a test message through the saved settings', async () => {
    const { sent, send } = mailer();
    const { app, adminCookie, aliceCookie } = await createTestApp({ sendMailImpl: send });

    // Nothing saved yet: told so, nothing sent.
    const early = await request(app).post('/api/config/mail-test').set('Cookie', adminCookie);
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/Save an SMTP URL/);
    expect(sent).toEqual([]);

    await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ smtp_url: 'smtp://u:p@smtp.example.com:587', alert_email: 'admin@example.com' });
    const res = await request(app).post('/api/config/mail-test').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, to: 'admin@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/Test message/);

    expect((await request(app).post('/api/config/mail-test').set('Cookie', aliceCookie)).status).toBe(403);
  });

  it('passes the mail server\'s refusal on', async () => {
    const { app, adminCookie } = await createTestApp({
      sendMailImpl: async () => {
        throw new Error('Invalid login: 535 Authentication failed');
      },
    });
    await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ smtp_url: 'smtp://u:p@smtp.example.com:587', alert_email: 'admin@example.com' });
    const res = await request(app).post('/api/config/mail-test').set('Cookie', adminCookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/535 Authentication failed/);
  });
});
