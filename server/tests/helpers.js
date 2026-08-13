import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moment from 'moment';
import { DataType, newDb } from 'pg-mem';
import request from 'supertest';
import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { createDeviceHub } from '../src/deviceHub.js';
import { issueDeviceToken } from '../src/services/deviceAuth.js';
import { hashPassword } from '../src/auth.js';
import { DEFAULT_RACK_NAME, findOrCreateRack } from '../src/services/racks.js';
import { textToPdf } from '../src/services/textPdf.js';

// pg-mem hands timestamps to Sequelize as strings moment can only parse via
// its js-Date fallback; the resulting deprecation warning would spam the run.
moment.suppressDeprecationWarnings = true;

// pg-mem has no text-search engine: no tsvector type, no to_tsvector, no @@.
// The manual search (migration 018 + routes/manuals.js) is written in real
// postgres text search, so the pieces it uses are shimmed here — the SQL under
// test stays exactly the SQL that runs in production, and these stand-ins
// answer it well enough to exercise matching, ranking, snippets and (most
// importantly) who is allowed to see which document.
//
// The shim is a plain token match with a crude plural rule where postgres
// stems properly, so it is close to but not the same as the real engine.
const tsWords = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    // Stand-in for the english stemmer: enough that "oscillators" finds
    // "oscillator", not enough to pretend it is Snowball.
    .map((word) => (word.length >= 4 && word.endsWith('s') ? word.slice(0, -1) : word));

// websearch_to_tsquery's syntax, reduced to what it means here: bare words are
// required, "quoted phrases" are their words, and -word excludes.
const tsQuery = (text) => {
  const terms = [];
  for (const raw of String(text ?? '').match(/"[^"]*"|\S+/g) || []) {
    const negated = raw.startsWith('-');
    const body = negated ? raw.slice(1) : raw;
    for (const word of tsWords(body)) terms.push((negated ? '!' : '') + word);
  }
  return terms.join(' ');
};

const tsTerms = (query) =>
  String(query ?? '')
    .split(' ')
    .filter(Boolean);

const tsMatches = (vector, query) => {
  const words = new Set(String(vector ?? '').split(' ').filter(Boolean));
  const terms = tsTerms(query);
  if (terms.length === 0) return false;
  return terms.every((term) =>
    term.startsWith('!') ? !words.has(term.slice(1)) : words.has(term)
  );
};

function registerTextSearch(mem) {
  const schema = mem.public;
  const text = DataType.text;
  schema.registerFunction({
    name: 'to_tsvector',
    args: [text, text],
    returns: text,
    implementation: (_config, document) => tsWords(document).join(' '),
  });
  schema.registerFunction({
    name: 'websearch_to_tsquery',
    args: [text, text],
    returns: text,
    implementation: (_config, query) => tsQuery(query),
  });
  schema.registerOperator({
    operator: '@@',
    left: text,
    right: text,
    returns: DataType.bool,
    implementation: tsMatches,
  });
  // Rank on how often the wanted words occur, normalized the way ts_rank's
  // output is: a small positive number that orders hits sensibly.
  schema.registerFunction({
    name: 'ts_rank',
    args: [text, text],
    returns: DataType.float,
    implementation: (vector, query) => {
      const words = String(vector ?? '').split(' ').filter(Boolean);
      const wanted = tsTerms(query).filter((term) => !term.startsWith('!'));
      if (words.length === 0 || wanted.length === 0) return 0;
      const hits = words.filter((word) => wanted.includes(word)).length;
      return hits / (hits + 10);
    },
  });
  // A window of words around the first hit, with the matches wrapped in the
  // StartSel/StopSel the caller asked for.
  schema.registerFunction({
    name: 'ts_headline',
    args: [text, text, text, text],
    returns: text,
    implementation: (_config, document, query, options) => {
      const start = /StartSel=([^,]*)/.exec(options || '')?.[1] ?? '';
      const stop = /StopSel=([^,]*)/.exec(options || '')?.[1] ?? '';
      const wanted = new Set(tsTerms(query).filter((term) => !term.startsWith('!')));
      const words = String(document ?? '').split(/\s+/).filter(Boolean);
      const isHit = (word) => tsWords(word).some((w) => wanted.has(w));
      const at = words.findIndex(isHit);
      const from = Math.max(0, (at === -1 ? 0 : at) - 6);
      return words
        .slice(from, from + 18)
        .map((word) => (isHit(word) ? `${start}${word}${stop}` : word))
        .join(' ');
    },
  });
}

// In-memory postgres + migrations, wrapped in the app's Sequelize database
// object. db.query() is a raw-SQL escape hatch for test fixtures/assertions,
// backed by the same pg-mem instance.
export async function createTestDb() {
  const mem = newDb();
  // Sequelize issues SET statements (timezone, client_min_messages) on
  // connect that pg-mem cannot parse; swallow them.
  mem.public.interceptQueries((sql) => (/^set\s/i.test(sql.trim()) ? [] : null));
  registerTextSearch(mem);
  const adapter = mem.adapters.createPg();
  const db = createDatabase({ dialectModule: adapter, databaseVersion: '13.4.0' });
  const pool = new adapter.Pool();
  db.query = (...args) => pool.query(...args);
  await migrate(db);
  return db;
}

export async function createUser(db, { username, password = 'password123', isAdmin = false }) {
  const user = await db.models.User.create({
    username,
    password_hash: hashPassword(password),
    is_admin: isAdmin,
  });
  return user.get({ plain: true });
}

// Logs in via the API and returns the session cookie header value.
export async function login(app, username, password = 'password123') {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

// Standard fixture: app + admin ('admin') + regular user ('alice').
// A device hub is always attached so the oscilloscope routes are exercisable;
// with no device registered it simply reports nothing connected.
export async function createTestApp({ hub = createDeviceHub() } = {}) {
  const db = await createTestDb();
  const manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-manuals-'));
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-exports-'));
  const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-captures-'));
  const panelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-panels-'));
  const app = createApp(db, {
    manualsDir,
    exportsDir,
    capturesDir,
    panelsDir,
    hub,
    rateLimit: false,
  });
  await createUser(db, { username: 'admin', isAdmin: true });
  await createUser(db, { username: 'alice' });
  const adminCookie = await login(app, 'admin');
  const aliceCookie = await login(app, 'alice');
  return {
    db,
    app,
    hub,
    manualsDir,
    exportsDir,
    capturesDir,
    panelsDir,
    adminCookie,
    aliceCookie,
  };
}

// A fake oscilloscope: registers with the hub, answers requests from a
// scripted map of action -> payload (or function), and records what it was
// asked. `state` is what the device announces about itself.
//
// Pass `db` to have it hold a real device token, which is what a capture
// records itself as coming from.
export async function connectFakeDevice(hub, db, options = {}) {
  const { token } = await issueDeviceToken(db, {
    userId: options.userId,
    clientId: 'cvosc',
    name: options.name || 'CVOsc',
    scopes: 'oscilloscope',
  });
  return fakeDevice(hub, { ...options, tokenId: token.id });
}

export function fakeDevice(hub, { userId, tokenId = 1, name = 'CVOsc', state = {}, answers = {} }) {
  const sent = [];
  const connection = hub.register({
    userId,
    tokenId,
    name,
    clientId: 'cvosc',
    send: (message) => {
      sent.push(message);
      if (message.type !== 'request') return;
      const responder = answers[message.action];
      // An action with no scripted answer is left hanging on purpose, so
      // tests can exercise the timeout path.
      if (responder === undefined) return;
      Promise.resolve(typeof responder === 'function' ? responder(message.params) : responder)
        .then((payload) =>
          hub.handleMessage(connection, {
            type: 'result',
            request_id: message.request_id,
            payload,
          })
        )
        .catch((e) =>
          hub.handleMessage(connection, {
            type: 'error',
            request_id: message.request_id,
            error: e.message,
          })
        );
    },
    close: () => hub.unregister(connection),
  });
  hub.handleMessage(connection, { type: 'hello', ...state });
  return { connection, sent };
}

// Creates a shared module record, maps it into one of userId's racks (their
// 'main rack' unless `rack` names another, created on demand), and (when
// manual_hash is given) records it as the shared auto-found manual. Passing
// manual_text records that manual as already extracted to markdown.
export async function insertModule(db, userId, fields = {}) {
  const {
    manufacturer = 'Make Noise',
    name = 'Maths',
    quantity = 1,
    rack = DEFAULT_RACK_NAME,
    manual_hash = null,
    manual_text = null,
    manual_status = manual_hash ? 'found' : 'pending',
    analysis_status = 'pending',
    panel_status = 'pending',
    hp = null,
    summary = null,
  } = fields;
  const module = await db.models.Module.create({
    manufacturer,
    name,
    manual_status,
    analysis_status,
    panel_status,
    hp,
    summary,
  });
  let rackId = null;
  if (userId) {
    const rackRow = await findOrCreateRack(db, userId, rack);
    rackId = rackRow.id;
    await db.models.RackModule.create({ rack_id: rackId, module_id: module.id, quantity });
  }
  if (manual_hash) {
    const manual = await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: manual_hash,
      source: 'found',
    });
    if (manual_text) {
      await insertManualText(db, manual.get({ plain: true }), {
        title: `${manufacturer} ${name}`,
        content: manual_text,
      });
    }
  }
  return { ...module.get({ plain: true }), quantity, rack_id: rackId };
}

// The extracted markdown of a document, as the extract_manual job would have
// stored it. Visibility rides on the manual: user_id null is the shared
// manual's text, a user_id is that user's upload.
export async function insertManualText(db, manual, { title = null, content = '' } = {}) {
  const row = await db.models.ManualDocument.create({
    manual_id: manual.id,
    module_id: manual.module_id,
    user_id: manual.user_id ?? null,
    hash: manual.hash,
    title,
    content,
    pages: Math.max(1, content.split('\f').length),
    chars: content.length,
    source: 'pdftotext',
  });
  return row.get({ plain: true });
}

// Maps an existing shared module into one of userId's racks (their 'main
// rack' unless `rack` names another, created on demand).
export async function mapModule(db, userId, moduleId, fields = {}) {
  const { rack = DEFAULT_RACK_NAME, quantity = 1 } = fields;
  const rackRow = await findOrCreateRack(db, userId, rack);
  await db.models.RackModule.create({ rack_id: rackRow.id, module_id: moduleId, quantity });
  return rackRow.get({ plain: true });
}

// A small PDF file body, and its content hash (documents are stored on disk
// as <hash>.pdf). Built with the app's own PDF writer so it is structurally
// complete — acquisition parses candidate manuals with pdfinfo, which a
// hand-written stub with no xref table would fail.
export const PDF_BYTES = textToPdf([{ text: 'Test Manual', bold: true }, { text: 'Page one.' }]);
export const PDF_HASH = crypto.createHash('sha256').update(PDF_BYTES).digest('hex');

// The same PDF cut short mid-body: header intact, xref table and %%EOF gone —
// the shape of a manual served truncated by its host.
export const TRUNCATED_PDF_BYTES = PDF_BYTES.subarray(0, 400);

// A valid 1x1 PNG — the smallest thing a device can plausibly send back as a
// captured waveform, with a real PNG signature so the capture parser accepts
// it.
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

// Fake LLM backend whose responses are scripted per method.
export function fakeBackend(responses = {}) {
  const calls = {
    completeText: [],
    completeTextWithSearch: [],
    answerWithDocuments: [],
    analyzeDocument: [],
    analyzeImage: [],
  };
  const respond = (value, args) => {
    if (typeof value === 'function') return Promise.resolve(value(...args));
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? '');
  };
  return {
    calls,
    completeText(...args) {
      calls.completeText.push(args);
      return respond(responses.completeText, args);
    },
    completeTextWithSearch(...args) {
      calls.completeTextWithSearch.push(args);
      return respond(responses.completeTextWithSearch, args);
    },
    answerWithDocuments(...args) {
      calls.answerWithDocuments.push(args);
      return respond(responses.answerWithDocuments, args);
    },
    analyzeDocument(...args) {
      calls.analyzeDocument.push(args);
      return respond(responses.analyzeDocument, args);
    },
    analyzeImage(...args) {
      calls.analyzeImage.push(args);
      return respond(responses.analyzeImage, args);
    },
  };
}

// fetch stub driven by a url-substring -> response map.
export function fakeFetch(routes) {
  const requested = [];
  const impl = async (url) => {
    requested.push(String(url));
    for (const [match, responder] of Object.entries(routes)) {
      if (String(url).includes(match)) {
        const r = typeof responder === 'function' ? await responder(url) : responder;
        if (r.error) throw new Error(r.error);
        return {
          ok: r.status === undefined || (r.status >= 200 && r.status < 300),
          status: r.status ?? 200,
          text: async () => r.text ?? '',
          json: async () => r.json ?? {},
          arrayBuffer: async () => {
            const buf = r.body ?? Buffer.from(r.text ?? '');
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          },
          body: null,
        };
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  impl.requested = requested;
  return impl;
}
