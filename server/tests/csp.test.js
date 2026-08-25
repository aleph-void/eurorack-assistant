// The content security policy, and the reports it asks browsers for.
//
// Three things are checked here, because the feature is three things: the
// policy the API is served under (src/csp.js), the policy the CLIENT SHELL is
// served under (nginx/csp.conf, which no test can execute — so it is read and
// held to its invariants instead), and the route that receives what a browser
// refused (routes/cspReports.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule, PNG_BYTES } from './helpers.js';
import { API_POLICY, CSP_REPORT_PATH, STORED_FILE_POLICY } from '../src/csp.js';
import {
  MAX_REPORTS_PER_REQUEST,
  fingerprint,
  parseReports,
} from '../src/services/cspReports.js';

const NGINX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'nginx'
);
const readNginx = (file) => fs.readFileSync(path.join(NGINX, file), 'utf8');

// One violation as Firefox, Safari and Chromium-on-http all send it: content
// type application/csp-report, hyphenated keys, wrapped in "csp-report".
const legacyReport = (overrides = {}) => ({
  'csp-report': {
    'document-uri': 'https://rack.example/modules/12',
    referrer: '',
    'violated-directive': "img-src 'self'",
    'effective-directive': 'img-src',
    'original-policy': "default-src 'self'; img-src 'self'; report-uri /api/csp-reports",
    disposition: 'enforce',
    'blocked-uri': 'https://tracker.example/pixel.gif',
    'line-number': 12,
    'column-number': 4,
    'source-file': 'https://rack.example/assets/index.js',
    'status-code': 200,
    'script-sample': '',
    ...overrides,
  },
});

// The same violation as the Reporting API delivers it: a batch, camelCased,
// under `body`, with the browser in the envelope.
const modernReport = (overrides = {}) => [
  {
    age: 12,
    type: 'csp-violation',
    url: 'https://rack.example/modules/12',
    user_agent: 'Mozilla/5.0 (Chromium)',
    body: {
      documentURL: 'https://rack.example/modules/12',
      referrer: '',
      effectiveDirective: 'img-src',
      originalPolicy: "default-src 'self'; img-src 'self'",
      disposition: 'enforce',
      blockedURL: 'https://tracker.example/pixel.gif',
      lineNumber: 12,
      columnNumber: 4,
      sourceFile: 'https://rack.example/assets/index.js',
      statusCode: 200,
      sample: '',
      ...overrides,
    },
  },
];

const post = (app, body, type = 'application/csp-report') =>
  request(app).post(CSP_REPORT_PATH).type(type).send(JSON.stringify(body));

describe('the API policy', () => {
  it('permits nothing at all', () => {
    expect(API_POLICY).toContain("default-src 'none'");
    expect(API_POLICY).toContain("frame-ancestors 'none'");
    expect(API_POLICY).toContain("base-uri 'none'");
    expect(API_POLICY).toContain("form-action 'none'");
  });

  // A drawn panel is an SVG with a <style> block in it, so the routes that
  // stream stored bytes permit that one thing and nothing else.
  it('permits a stored file its own styling, and only that', () => {
    expect(STORED_FILE_POLICY.startsWith(API_POLICY)).toBe(true);
    expect(STORED_FILE_POLICY).toContain("style-src 'unsafe-inline'");
    expect(STORED_FILE_POLICY).not.toContain('script-src');
  });

  it('rides on every API response, answered or refused', async () => {
    const { app, aliceCookie } = await createTestApp();
    for (const [method, url] of [
      ['get', '/api/health'],
      ['get', '/api/modules'],
      ['get', '/api/nothing-here'],
    ]) {
      const res = await request(app)[method](url).set('Cookie', aliceCookie);
      expect(res.headers['content-security-policy']).toBe(API_POLICY);
    }
  });

  it('is replaced by the stored-file policy where bytes are streamed', async () => {
    const ctx = await createTestApp();
    const alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(ctx.db, alice.id);
    const crypto = await import('node:crypto');
    const { panelPath } = await import('../src/services/image.js');
    const bytes = PNG_BYTES;
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(panelPath(ctx.panelsDir, hash, 'png'), bytes);
    await ctx.db.models.ModulePanel.create({
      module_id: module.id,
      source: 'image',
      image_hash: hash,
      image_ext: 'png',
      width: 400,
      height: 1200,
    });
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(STORED_FILE_POLICY);
  });
});

// nginx serves the pages a person looks at, and no test here can run nginx.
// What CAN be checked is that the file still says the things the whole design
// rests on — above all that it points at the route below, and that the one
// directive protecting a signed-in session has not been loosened to make
// something else work.
describe('the client shell policy', () => {
  // The directives only: half of that file is the reasoning behind them, and
  // a comment saying what is NOT permitted must not read as permission.
  const policy = readNginx('csp.conf')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('points its reports at the route that receives them', () => {
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain(`csp=\\"${CSP_REPORT_PATH}\\"`);
  });

  it('never permits inline or evaluated script', () => {
    const directives = policy.match(/script-src[^;"]*/g) || [];
    expect(directives.length).toBeGreaterThan(0);
    for (const directive of directives) {
      expect(directive).toContain("'self'");
      expect(directive).not.toContain("'unsafe-inline'");
      // 'wasm-unsafe-eval' is WebAssembly compilation and nothing else; the
      // bare keyword would be script from a string.
      expect(directive.replace(/'wasm-unsafe-eval'/g, '')).not.toContain("'unsafe-eval'");
    }
  });

  it('keeps the directives that need no exception', () => {
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  // The live job feed is a WebSocket to this same host, and it is named
  // outright because browsers have never agreed that 'self' covers ws://.
  it('names the WebSocket rather than trusting self to cover it', () => {
    expect(policy).toContain('ws://$http_host wss://$http_host');
    // ...but never a bare scheme, which would be a socket to anywhere.
    expect(policy).not.toMatch(/connect-src[^;"]*\bwss?:(?!\/\/)/);
  });

  it('is carried by every location that serves the client, in both vhosts', () => {
    const headers = readNginx('csp-headers.conf');
    expect(headers).toContain('add_header Content-Security-Policy $csp_enforced');
    expect(headers).toContain('add_header Content-Security-Policy-Report-Only $csp_report_only');
    // add_header does not inherit into a location that sets one of its own,
    // so cache.conf's two locations have to include it as well as the SPA
    // fallback in each vhost.
    const include = 'include /etc/nginx/snippets/csp-headers.conf;';
    for (const file of ['nginx.conf', 'tls.conf.template']) {
      expect(readNginx(file)).toContain(include);
    }
    expect(readNginx('cache.conf').split(include).length - 1).toBe(2);
    // And it is in the image, or nginx would not start at all.
    expect(readNginx('Dockerfile')).toContain('COPY nginx/csp.conf /etc/nginx/conf.d/00-csp.conf');
    expect(readNginx('Dockerfile')).toContain(
      'COPY nginx/csp-headers.conf /etc/nginx/snippets/csp-headers.conf'
    );
  });
});

describe('reading a violation report', () => {
  it('reads the shape report-uri sends', () => {
    const [violation] = parseReports(legacyReport(), { userAgent: 'Firefox' });
    expect(violation).toMatchObject({
      directive: 'img-src',
      document_uri: 'https://rack.example/modules/12',
      blocked_uri: 'https://tracker.example/pixel.gif',
      source_file: 'https://rack.example/assets/index.js',
      line_number: 12,
      column_number: 4,
      disposition: 'enforce',
      user_agent: 'Firefox',
    });
  });

  it('reads the shape the Reporting API sends, browser and all', () => {
    const [violation] = parseReports(modernReport(), { userAgent: 'the delivery' });
    expect(violation).toMatchObject({
      directive: 'img-src',
      blocked_uri: 'https://tracker.example/pixel.gif',
      line_number: 12,
      // The envelope's user agent is the browser that SAW it; the request's
      // own may belong to a delivery made minutes later.
      user_agent: 'Mozilla/5.0 (Chromium)',
    });
  });

  it('takes the directive name out of the older violated-directive', () => {
    const body = legacyReport();
    delete body['csp-report']['effective-directive'];
    expect(parseReports(body)[0].directive).toBe('img-src');
  });

  it('ignores the other things the Reporting API delivers', () => {
    const batch = [
      { type: 'deprecation', body: { id: 'x', message: 'old' } },
      ...modernReport(),
    ];
    expect(parseReports(batch)).toHaveLength(1);
  });

  it('stops reading a delivery that goes on forever', () => {
    const batch = Array.from({ length: MAX_REPORTS_PER_REQUEST + 25 }, (v, i) =>
      modernReport({ blockedURL: `https://tracker.example/${i}.gif` })[0]
    );
    expect(parseReports(batch)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });

  it('truncates what a stranger sends rather than storing it', () => {
    const [violation] = parseReports(
      legacyReport({ 'blocked-uri': `data:image/png;base64,${'A'.repeat(50000)}` })
    );
    expect(violation.blocked_uri.length).toBe(1024);
  });

  it('answers nothing at all for something that is not a report', () => {
    for (const body of [null, undefined, 'a string', 42, {}, [], [null], { hello: 'world' }]) {
      expect(parseReports(body)).toEqual([]);
    }
  });

  it('makes one fingerprint of one complaint, whichever shape it arrived in', () => {
    const [legacy] = parseReports(legacyReport(), { userAgent: 'Firefox' });
    const [modern] = parseReports(modernReport());
    // The two shapes above describe the same violation, and the browser that
    // saw it is deliberately not part of what makes it the same.
    expect(fingerprint(legacy)).toBe(fingerprint(modern));
    const [other] = parseReports(legacyReport({ 'blocked-uri': 'inline' }));
    expect(fingerprint(other)).not.toBe(fingerprint(legacy));
  });
});

describe('the report route', () => {
  it('takes a report from a browser with no session at all', async () => {
    const { app, db } = await createTestApp();
    // No cookie, and none of the headers a browser attaches to a request a
    // PAGE made — which is exactly what a violation report looks like on the
    // wire.
    expect((await post(app, legacyReport())).status).toBe(204);
    const rows = await db.models.CspReport.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].directive).toBe('img-src');
    expect(rows[0].report_count).toBe(1);
  });

  it('takes the Reporting API delivery too', async () => {
    const { app, db } = await createTestApp();
    expect((await post(app, modernReport(), 'application/reports+json')).status).toBe(204);
    expect(await db.models.CspReport.count()).toBe(1);
  });

  it('counts a violation up rather than filling the table with it', async () => {
    const { app, db, adminCookie } = await createTestApp();
    for (let i = 0; i < 5; i++) expect((await post(app, legacyReport())).status).toBe(204);
    const list = await request(app).get(CSP_REPORT_PATH).set('Cookie', adminCookie);
    expect(list.body.total).toBe(1);
    expect(list.body.reported).toBe(5);
    const [row] = await db.models.CspReport.findAll();
    expect(row.report_count).toBe(5);
    expect(new Date(row.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.first_seen_at).getTime()
    );
  });

  it('keeps two different complaints apart', async () => {
    const { app, db } = await createTestApp();
    await post(app, legacyReport());
    await post(app, legacyReport({ 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline' }));
    expect(await db.models.CspReport.count()).toBe(2);
  });

  it('answers a body that is not a report without a stack trace', async () => {
    const { app, db } = await createTestApp();
    const res = await request(app)
      .post(CSP_REPORT_PATH)
      .type('application/csp-report')
      .send('{not json');
    expect(res.status).toBe(400);
    // Something well-formed that says nothing is simply nothing to record.
    expect((await post(app, { 'csp-report': { hello: 'world' } })).status).toBe(204);
    expect(await db.models.CspReport.count()).toBe(0);
  });
});

describe('reading the reports back', () => {
  it('is the admin\'s alone', async () => {
    const { app, aliceCookie } = await createTestApp();
    await post(app, legacyReport());
    expect((await request(app).get(CSP_REPORT_PATH)).status).toBe(401);
    expect((await request(app).get(CSP_REPORT_PATH).set('Cookie', aliceCookie)).status).toBe(403);
    expect((await request(app).delete(CSP_REPORT_PATH).set('Cookie', aliceCookie)).status).toBe(403);
    expect(
      (await request(app).delete(`${CSP_REPORT_PATH}/1`).set('Cookie', aliceCookie)).status
    ).toBe(403);
  });

  it('answers one page at a time, newest first', async () => {
    const { app, adminCookie } = await createTestApp();
    for (let i = 0; i < 5; i++) {
      await post(app, legacyReport({ 'blocked-uri': `https://tracker.example/${i}.gif` }));
    }
    const first = await request(app)
      .get(`${CSP_REPORT_PATH}?limit=2`)
      .set('Cookie', adminCookie);
    expect(first.status).toBe(200);
    expect(first.body.reports).toHaveLength(2);
    expect(first.body.total).toBe(5);
    expect(first.body.has_more).toBe(true);
    expect(first.body.reports[0].id).toBeGreaterThan(first.body.reports[1].id);

    const next = await request(app)
      .get(`${CSP_REPORT_PATH}?limit=2&before=${first.body.next_before}`)
      .set('Cookie', adminCookie);
    expect(next.body.reports.map((r) => r.id)).toEqual([3, 2]);
    expect(next.body.has_more).toBe(true);

    const last = await request(app)
      .get(`${CSP_REPORT_PATH}?limit=2&before=${next.body.next_before}`)
      .set('Cookie', adminCookie);
    expect(last.body.reports.map((r) => r.id)).toEqual([1]);
    expect(last.body.has_more).toBe(false);
    expect(last.body.next_before).toBe(null);
  });

  it('never hands out the fingerprint it recognises repeats by', async () => {
    const { app, adminCookie } = await createTestApp();
    await post(app, legacyReport());
    const res = await request(app).get(CSP_REPORT_PATH).set('Cookie', adminCookie);
    expect(res.body.reports[0].fingerprint).toBeUndefined();
    expect(res.body.reports[0].blocked_uri).toBe('https://tracker.example/pixel.gif');
  });

  it('empties the table, one row or all of them', async () => {
    const { app, db, adminCookie } = await createTestApp();
    await post(app, legacyReport());
    await post(app, legacyReport({ 'blocked-uri': 'inline' }));
    const [first] = await db.models.CspReport.findAll({ order: [['id', 'ASC']] });

    const one = await request(app)
      .delete(`${CSP_REPORT_PATH}/${first.id}`)
      .set('Cookie', adminCookie);
    expect(one.status).toBe(200);
    expect(await db.models.CspReport.count()).toBe(1);
    expect(
      (await request(app).delete(`${CSP_REPORT_PATH}/${first.id}`).set('Cookie', adminCookie)).status
    ).toBe(404);

    const all = await request(app).delete(CSP_REPORT_PATH).set('Cookie', adminCookie);
    expect(all.status).toBe(200);
    expect(all.body.deleted).toBe(1);
    expect(await db.models.CspReport.count()).toBe(0);
  });
});
