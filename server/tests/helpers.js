import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moment from 'moment';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

// pg-mem hands timestamps to Sequelize as strings moment can only parse via
// its js-Date fallback; the resulting deprecation warning would spam the run.
moment.suppressDeprecationWarnings = true;

// In-memory postgres + migrations, wrapped in the app's Sequelize database
// object. db.query() is a raw-SQL escape hatch for test fixtures/assertions,
// backed by the same pg-mem instance.
export async function createTestDb() {
  const mem = newDb();
  // Sequelize issues SET statements (timezone, client_min_messages) on
  // connect that pg-mem cannot parse; swallow them.
  mem.public.interceptQueries((sql) => (/^set\s/i.test(sql.trim()) ? [] : null));
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
export async function createTestApp() {
  const db = await createTestDb();
  const manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-manuals-'));
  const app = createApp(db, { manualsDir });
  await createUser(db, { username: 'admin', isAdmin: true });
  await createUser(db, { username: 'alice' });
  const adminCookie = await login(app, 'admin');
  const aliceCookie = await login(app, 'alice');
  return { db, app, manualsDir, adminCookie, aliceCookie };
}

// Creates a shared module record, maps it into userId's system, and (when
// manual_hash is given) records it as the shared auto-found manual.
export async function insertModule(db, userId, fields = {}) {
  const {
    manufacturer = 'Make Noise',
    name = 'Maths',
    quantity = 1,
    manual_hash = null,
    manual_status = manual_hash ? 'found' : 'pending',
    analysis_status = 'pending',
    summary = null,
  } = fields;
  const module = await db.models.Module.create({
    manufacturer,
    name,
    manual_status,
    analysis_status,
    summary,
  });
  if (userId) {
    await db.models.UserModule.create({ user_id: userId, module_id: module.id, quantity });
  }
  if (manual_hash) {
    await db.models.Manual.create({
      module_id: module.id,
      user_id: null,
      hash: manual_hash,
      source: 'found',
    });
  }
  return { ...module.get({ plain: true }), quantity };
}

// A minimal-but-valid PDF file body, and its content hash (documents are
// stored on disk as <hash>.pdf).
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
);
export const PDF_HASH = crypto.createHash('sha256').update(PDF_BYTES).digest('hex');

// Fake LLM backend whose responses are scripted per method.
export function fakeBackend(responses = {}) {
  const calls = { completeText: [], completeTextWithSearch: [], answerWithDocuments: [], analyzeDocument: [] };
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
