import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from './helpers.js';
import { getMailConfig, mailConfigJson, setMailConfig } from '../src/services/mailConfig.js';
import { sendMail } from '../src/services/mailer.js';
import { getConfig } from '../src/services/config.js';

describe('mail server settings', () => {
  it('start empty, say why nothing can be sent, and never serve the password', async () => {
    const { app, adminCookie } = await createTestApp({ mail: false });
    const res = await request(app).get('/api/config/mail').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.mail_host).toBe('');
    expect(res.body.mail_port).toBe(587);
    expect(res.body.mail_secure).toBe(false);
    expect(res.body.mail_password_set).toBe(false);
    expect(res.body).not.toHaveProperty('mail_password');
    expect(res.body.problem).toMatch(/SMTP host/);
    expect(res.body.settings.map((s) => s.key)).toContain('public_url');
  });

  it('are written by the admin, typed and cleaned', async () => {
    const { app, adminCookie, db } = await createTestApp({ mail: false });
    const res = await request(app)
      .put('/api/config/mail')
      .set('Cookie', adminCookie)
      .send({
        mail_host: ' smtp.example.org ',
        mail_port: '465',
        mail_secure: 'true',
        mail_user: 'rack',
        mail_password: 'hunter2',
        mail_from: 'Rack@Example.org',
        public_url: 'https://rack.example.org/',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mail_host: 'smtp.example.org',
      mail_port: 465,
      mail_secure: true,
      mail_user: 'rack',
      mail_password_set: true,
      mail_from: 'rack@example.org',
      public_url: 'https://rack.example.org',
      problem: null,
    });
    expect(res.body).not.toHaveProperty('mail_password');

    // At rest the password is ciphertext; read back for sending it is not.
    const { rows } = await db.query("SELECT value FROM app_config WHERE key = 'mail_password'");
    expect(rows[0].value).toMatch(/^v1\$/);
    expect(rows[0].value).not.toContain('hunter2');
    expect((await getMailConfig(db)).mail_password).toBe('hunter2');

    // The general config route never carries the mail rows.
    const general = await request(app).get('/api/config').set('Cookie', adminCookie);
    expect(general.body).not.toHaveProperty('mail_password');
    expect(general.body).not.toHaveProperty('mail_host');
    expect(await getConfig(db)).not.toHaveProperty('mail_password');

    // Not mentioning the password keeps it; blank removes it.
    await request(app).put('/api/config/mail').set('Cookie', adminCookie).send({ mail_user: 'other' });
    expect((await getMailConfig(db)).mail_password).toBe('hunter2');
    const cleared = await request(app)
      .put('/api/config/mail')
      .set('Cookie', adminCookie)
      .send({ mail_password: '' });
    expect(cleared.body.mail_password_set).toBe(false);
    expect((await getMailConfig(db)).mail_password).toBe('');
  });

  it('refuse what cannot be a setting', async () => {
    const { app, adminCookie } = await createTestApp({ mail: false });
    const bad = [
      { mail_host: 'smtp://example.org' },
      { mail_host: 'smtp.example.org:25' },
      { mail_port: 0 },
      { mail_port: 70000 },
      { mail_port: 'abc' },
      { mail_secure: 'maybe' },
      { mail_from: 'not-an-address' },
      { public_url: 'rack.example.org' },
      { public_url: 'ftp://rack.example.org' },
      { public_url: 'https://rack.example.org/?x=1' },
      { public_url: 'https://user@rack.example.org' },
      { youtube_api_key: 'x' },
      {},
    ];
    for (const body of bad) {
      const res = await request(app).put('/api/config/mail').set('Cookie', adminCookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // A path prefix is allowed; a trailing slash is dropped.
    const ok = await request(app)
      .put('/api/config/mail')
      .set('Cookie', adminCookie)
      .send({ public_url: 'http://rack.example.org/app/' });
    expect(ok.body.public_url).toBe('http://rack.example.org/app');
  });

  it('are the admin\'s alone', async () => {
    const { app, aliceCookie } = await createTestApp();
    expect((await request(app).get('/api/config/mail').set('Cookie', aliceCookie)).status).toBe(403);
    expect(
      (await request(app).put('/api/config/mail').set('Cookie', aliceCookie).send({ mail_host: 'x' })).status
    ).toBe(403);
    expect((await request(app).post('/api/config/mail/test').set('Cookie', aliceCookie)).status).toBe(403);
  });

  it('a test mail goes to the admin, through the configured transport', async () => {
    const { app, adminCookie, sentMail } = await createTestApp();
    const res = await request(app).post('/api/config/mail/test').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.to).toBe('admin@example.org');
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({ from: 'rack@example.org', to: 'admin@example.org' });
    expect(sentMail[0].subject).toMatch(/test mail/);
  });

  it('a test mail that cannot go says why', async () => {
    const unset = await createTestApp({ mail: false });
    const res = await request(unset.app).post('/api/config/mail/test').set('Cookie', unset.adminCookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/not set up/);

    const broken = await createTestApp({
      mailImpl: async () => {
        throw new Error('connection refused');
      },
    });
    const failed = await request(broken.app).post('/api/config/mail/test').set('Cookie', broken.adminCookie);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatch(/connection refused/);
  });

  it('sendMail hands the transport the typed settings', async () => {
    const db = await createTestDb();
    await setMailConfig(db, {
      mail_host: 'smtp.example.org',
      mail_port: 2525,
      mail_user: 'u',
      mail_password: 'p',
      mail_from: 'rack@example.org',
      public_url: 'https://rack.example.org',
    });
    const seen = [];
    const result = await sendMail(
      db,
      { to: 'x@example.net', subject: 's', text: 't' },
      { mailImpl: async (message, config) => seen.push({ message, config }) }
    );
    expect(result).toEqual({ sent: true, problem: null });
    expect(seen[0].message).toEqual({ from: 'rack@example.org', to: 'x@example.net', subject: 's', text: 't' });
    expect(seen[0].config).toMatchObject({ mail_host: 'smtp.example.org', mail_port: 2525, mail_user: 'u', mail_password: 'p' });
    expect(mailConfigJson(seen[0].config).mail_password_set).toBe(true);
  });
});
