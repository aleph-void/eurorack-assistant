import fs from 'node:fs';
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { requireAuth } from '../auth.js';
import { manualPath, safeManualName } from '../services/pdf.js';
import { readableIds } from '../services/sharing.js';
import { asyncHandler } from './asyncHandler.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

// The text search configuration. It has to be the same one the index in
// migration 018 was built with, or the planner cannot use the index.
const TS_CONFIG = 'english';

// How a hit is marked up in the returned snippet. Deliberately not HTML: the
// snippet is a fragment of the manual's markdown and the client renders it as
// text, so the markers are something a manual would never contain and the
// client turns into highlighting itself.
export const HIGHLIGHT_START = '[[';
export const HIGHLIGHT_END = ']]';
const HEADLINE_OPTIONS =
  `StartSel=${HIGHLIGHT_START},StopSel=${HIGHLIGHT_END},` +
  'MaxFragments=3,MinWords=6,MaxWords=18,FragmentDelimiter=" … "';

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Documents are retrieved by content hash. A hash is fetchable when a manual
// record visible to the requesting user references it: the shared auto-found
// manual of any module, or one of the user's own uploads.
export function manualRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const { Manual, ManualDocument, Module } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // What the requesting user may see, in both tables: everything belonging to
  // a shared manual, plus their own uploads and nobody else's — and, since
  // migration 019, any upload whose owner shared that document with them.
  const visibleToUser = (row, userId, sharedManualIds = new Set()) =>
    row.user_id === null || row.user_id === userId || sharedManualIds.has(row.manual_id ?? row.id);

  // The manual rows other people have shared with this user. Fetched per
  // request rather than folded into the query: the visibility test spans two
  // tables and a share list, and a hash is carried by a handful of rows at
  // most, so the filtering costs nothing in JS and stays correct on pg-mem
  // (which drops rows when an OR is ANDed with anything else).
  const sharedManualIds = async (userId) =>
    new Set(await readableIds(db, userId, 'document'));

  // The first document record for the hash the requesting user may see (with
  // its module), plus the file on disk — or null when either is missing.
  async function accessibleManual(req, res) {
    const hash = String(req.params.hash).toLowerCase();
    if (!SHA256_RE.test(hash)) {
      res.status(404).json({ error: 'Document not found' });
      return null;
    }
    const shared = await sharedManualIds(req.user.id);
    const manuals = await Manual.findAll({
      where: { hash },
      include: Module,
      order: [['id', 'ASC']],
    });
    const manual = manuals.find((row) => visibleToUser(row, req.user.id, shared));
    const file = manualPath(manualsDir, hash);
    if (!manual || !fs.existsSync(file)) {
      res.status(404).json({ error: 'Document not found' });
      return null;
    }
    return { manual, file };
  }

  function sendPdf(res, file, disposition, filename) {
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `${disposition}; filename="${filename.replace(/["\\\r\n]/g, '_')}"`
    );
    // A manual is a user-supplied file served from the app's own origin. It is
    // accepted on a %PDF- prefix alone, so it could be a polyglot; stop the
    // browser from sniffing it into something scriptable, and forbid it from
    // loading or running anything if a viewer renders it inline. Mirrors the
    // policy the panel route already applies to its images.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    // The file is addressed by the hash of its own bytes, so it can never
    // change under that URL — the same policy the panel and capture images
    // are served with. Private, because who may read a manual is a question
    // this route answers per user; a shared cache must not answer it.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  }

  // Full-text search across every manual the user may read: the extracted
  // markdown of the shared manuals (all of them, exactly as the PDFs
  // themselves are readable by everyone) plus the documents this user
  // uploaded, which stay private to them.
  //
  // Query: ?q=<websearch syntax: bare words, "quoted phrases", -exclusions>
  //        &module_id= (search within one module) &limit= &offset=
  //
  // Each hit carries a snippet with the matched words wrapped in [[ ]], which
  // the client renders as highlighting.
  router.get('/search', asyncHandler(async (req, res) => {
    const query = String(req.query.q ?? '').trim().slice(0, MAX_QUERY_CHARS);
    if (!query) return res.status(400).json({ error: 'q is required' });
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT)
    );
    const offset = Math.max(0, Number(req.query.offset) || 0);

    // $1 the query, $2 the requesting user, $3/$4 the window, $5 the
    // optional module filter. The tsvector expression is written exactly as
    // the index in migration 018 declares it.
    const bind = [query, req.user.id, limit + 1, offset];
    let moduleFilter = '';
    if (req.query.module_id !== undefined && String(req.query.module_id).trim() !== '') {
      bind.push(Number(req.query.module_id) || 0);
      moduleFilter = `AND d.module_id = $${bind.length}`;
    }
    // Documents other people shared with this user join the searchable set.
    // Their ids are written into the SQL rather than bound because they are
    // a list of unknown length (and they are integers this server read out
    // of its own database a moment ago). The whole visibility test is one
    // CASE rather than the OR it reads as, for the pg-mem reason below.
    const shared = [...(await sharedManualIds(req.user.id))].map(Number).filter(Number.isInteger);
    const sharedTest = shared.length ? `WHEN d.manual_id IN (${shared.join(',')}) THEN 1` : '';
    const rows = await db.sequelize.query(
      `SELECT d.id, d.manual_id, d.module_id, d.user_id, d.hash, d.title,
              d.pages, d.chars, d.created_at,
              m.name AS manual_name, m.original_name, m.source,
              mo.manufacturer AS module_manufacturer, mo.name AS module_name,
              ts_rank(to_tsvector('${TS_CONFIG}', d.content),
                      websearch_to_tsquery('${TS_CONFIG}', $1)) AS rank,
              ts_headline('${TS_CONFIG}', d.content,
                          websearch_to_tsquery('${TS_CONFIG}', $1),
                          '${HEADLINE_OPTIONS}') AS snippet
         FROM manual_documents d
         JOIN manuals m ON m.id = d.manual_id
         JOIN modules mo ON mo.id = d.module_id
        -- The match comes first and the filters narrow it: the index answers
        -- the match, and the rows it returns are few enough that the rest is
        -- free. Visibility is written as a CASE rather than the more obvious
        -- "user_id IS NULL OR user_id = $2 OR manual_id IN (...)" — the two
        -- say exactly the same thing (the document is the shared manual, or
        -- yours, or one shared with you), and pg-mem, the test database,
        -- drops rows when an OR is ANDed with anything else (see
        -- tests/helpers.js).
        WHERE to_tsvector('${TS_CONFIG}', d.content)
              @@ websearch_to_tsquery('${TS_CONFIG}', $1)
          AND (CASE WHEN COALESCE(d.user_id, $2) = $2 THEN 1 ${sharedTest} ELSE 0 END) = 1
          ${moduleFilter}
        ORDER BY rank DESC, d.id ASC
        LIMIT $3 OFFSET $4`,
      { bind, type: QueryTypes.SELECT }
    );

    const hasMore = rows.length > limit;
    res.json({
      query,
      limit,
      offset,
      has_more: hasMore,
      results: rows.slice(0, limit).map((row) => ({
        manual_id: row.manual_id,
        module_id: row.module_id,
        hash: row.hash,
        title: row.title,
        name: row.manual_name,
        original_name: row.original_name,
        source: row.source,
        // Whose document this is: null for the shared manual every user
        // sees, the owner's id for an upload.
        user_id: row.user_id ?? null,
        manufacturer: row.module_manufacturer,
        module_name: row.module_name,
        pages: row.pages,
        chars: row.chars,
        rank: Number(row.rank) || 0,
        // A fragment cut out of the middle of the markdown, so it arrives
        // with the line breaks (and sometimes the heading marks) it had
        // there. It is shown as one line of context, so it is flattened
        // here rather than in every consumer.
        snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim(),
      })),
    });
  }));

  // The extracted markdown behind a document hash, for reading in the browser.
  // Visibility is the document row's own (shared, or this user's upload); the
  // PDF file does not have to still be on disk for its text to be readable.
  async function accessibleDocument(req, res) {
    const hash = String(req.params.hash).toLowerCase();
    if (!SHA256_RE.test(hash)) {
      res.status(404).json({ error: 'Document text not found' });
      return null;
    }
    // The visibility test is applied here rather than in the query: a hash is
    // shared by at most a handful of rows, and keeping the filter in JS keeps
    // this correct on both databases (pg-mem drops rows when an OR meets an
    // AND — see tests/helpers.js).
    const documents = await ManualDocument.findAll({
      where: { hash },
      include: Module,
      order: [['id', 'ASC']],
    });
    const shared = await sharedManualIds(req.user.id);
    const document = documents.find((row) => visibleToUser(row, req.user.id, shared));
    if (!document) {
      res.status(404).json({ error: 'Document text not found' });
      return null;
    }
    return document;
  }

  const documentJson = (document) => ({
    id: document.id,
    manual_id: document.manual_id,
    module_id: document.module_id,
    user_id: document.user_id,
    hash: document.hash,
    title: document.title,
    manufacturer: document.Module?.manufacturer ?? null,
    module_name: document.Module?.name ?? null,
    content: document.content,
    pages: document.pages,
    chars: document.chars,
    source: document.source,
    created_at: document.created_at,
    updated_at: document.updated_at,
  });

  router.get('/:hash/text', asyncHandler(async (req, res) => {
    const document = await accessibleDocument(req, res);
    if (!document) return;
    res.json(documentJson(document));
  }));

  // The same markdown as a file, named after the module the way the PDF export
  // is — so a manual can be kept alongside its own text.
  router.get('/:hash/text/export', asyncHandler(async (req, res) => {
    const document = await accessibleDocument(req, res);
    if (!document) return;
    const module = document.Module;
    const filename = safeManualName(
      module?.manufacturer ?? '',
      module?.name ?? 'module',
      'Manual'
    ).replace(/\.pdf$/, '.md');
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`
    );
    res.send(document.content);
  }));

  router.get('/:hash', asyncHandler(async (req, res) => {
    const found = await accessibleManual(req, res);
    if (!found) return;
    const { manual, file } = found;
    sendPdf(res, file, 'inline', manual.original_name || `${manual.hash}.pdf`);
  }));

  // Export downloads the document as an attachment named after the module it
  // belongs to and the document's database name.
  router.get('/:hash/export', asyncHandler(async (req, res) => {
    const found = await accessibleManual(req, res);
    if (!found) return;
    const { manual, file } = found;
    const module = manual.Module;
    sendPdf(res, file, 'attachment', safeManualName(module.manufacturer, module.name, manual.name));
  }));

  return router;
}
