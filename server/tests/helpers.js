import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

// In-memory postgres + migrations; returns a pg-compatible pool.
export async function createTestDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Pool();
  await migrate(db);
  return db;
}

export async function createUser(db, { username, password = 'password123', isAdmin = false }) {
  const { rows } = await db.query(
    'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING *',
    [username, hashPassword(password), isAdmin]
  );
  return rows[0];
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
// manual_filename is given) records it as the shared auto-found manual.
export async function insertModule(db, userId, fields = {}) {
  const {
    manufacturer = 'Make Noise',
    name = 'Maths',
    quantity = 1,
    manual_filename = null,
    manual_status = manual_filename ? 'found' : 'pending',
    analysis_status = 'pending',
    summary = null,
  } = fields;
  const { rows } = await db.query(
    `INSERT INTO modules (manufacturer, name, manual_status, analysis_status, summary)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [manufacturer, name, manual_status, analysis_status, summary]
  );
  const module = rows[0];
  if (userId) {
    await db.query(
      'INSERT INTO user_modules (user_id, module_id, quantity) VALUES ($1, $2, $3)',
      [userId, module.id, quantity]
    );
  }
  if (manual_filename) {
    await db.query(
      `INSERT INTO manuals (module_id, user_id, filename, source) VALUES ($1, NULL, $2, 'found')`,
      [module.id, manual_filename]
    );
  }
  return { ...module, quantity };
}

// A minimal-but-valid PDF file body.
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
);

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
