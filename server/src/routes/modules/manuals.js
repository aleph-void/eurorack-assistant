import fs from 'node:fs';
import { Router } from 'express';
import { isProbablyPdfBuffer, manualPath, sha256Buffer } from '../../services/pdf.js';
import { enqueueExtractManual } from '../../jobs/worker.js';
import { removeShares } from '../../services/sharing.js';
import { requireOwnedModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function moduleManualRoutes(db, { manualsDir }) {
  const {
    Manual,
    ManualDocument,
  } = db.models;
  const router = Router();

  // Attach an additional PDF document to your module instance. Body:
  // { name, filename, data_base64 }. Private to the uploading user. The name
  // labels the document; 'manual' is reserved for the shared auto-found
  // manual, so uploads must pick something else.
  router.post('/:id/manuals', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;

    const { name: rawName, filename, data_base64: dataBase64 } = req.body || {};
    if (!rawName || !filename || !dataBase64) {
      return res.status(400).json({ error: 'name, filename and data_base64 are required' });
    }
    const name = String(rawName).trim();
    if (!name) return res.status(400).json({ error: 'name, filename and data_base64 are required' });
    if (name.toLowerCase() === 'manual') {
      return res.status(400).json({ error: "'manual' is reserved for the shared manual" });
    }
    let data;
    try {
      data = Buffer.from(String(dataBase64), 'base64');
    } catch {
      return res.status(400).json({ error: 'data_base64 is not valid base64' });
    }
    if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: 'file is empty or larger than 25MB' });
    }

    const { ok, reason } = isProbablyPdfBuffer(data);
    if (!ok) return res.status(400).json({ error: `not a valid PDF (${reason})` });

    // Content-addressed storage: the file lands at <sha256>.pdf, so a
    // document that already exists (under any record) is stored once.
    const hash = sha256Buffer(data);
    const dest = manualPath(manualsDir, hash);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(manualsDir, { recursive: true });
      fs.writeFileSync(dest, data);
    }

    // Whether this document should ride along with the module's analysis;
    // omitted means "leave it alone" (false for a fresh upload).
    const scopeGiven = req.body?.analysis_scope !== undefined;
    const analysisScope = Boolean(req.body?.analysis_scope);

    // Re-uploading a document you already attached references the existing
    // record instead of creating a duplicate (the original file name is
    // kept — it names the same bytes).
    const existing = await Manual.findOne({
      where: { module_id: module.id, user_id: req.user.id, hash },
    });
    // A database name may not be reused for different content (backed by
    // the unique index on (module_id, name, hash)).
    const nameTaken = await Manual.findOne({
      where: { module_id: module.id, user_id: req.user.id, name },
    });
    if (nameTaken && nameTaken.id !== existing?.id) {
      return res
        .status(409)
        .json({ error: `you already have a document named '${name}' on this module` });
    }
    let manual = existing;
    if (manual) {
      // The typed name is an instruction either way: a re-upload under a
      // new name renames the document rather than being silently ignored.
      const updates = {};
      if (manual.name !== name) updates.name = name;
      if (scopeGiven && manual.analysis_scope !== analysisScope) {
        updates.analysis_scope = analysisScope;
      }
      if (Object.keys(updates).length > 0) await manual.update(updates);
    } else {
      manual = await Manual.create({
        module_id: module.id,
        user_id: req.user.id,
        hash,
        name,
        original_name: String(filename),
        source: 'upload',
        analysis_scope: analysisScope,
      });
    }

    // Your uploads are searchable too — only by you, since the document
    // record they hang off is yours alone. The extraction is a job rather
    // than part of this request: it shells out to pdftotext, which a browser
    // upload should not have to wait on. A re-upload of a document that has
    // already been extracted needs nothing done again.
    const hasText = await ManualDocument.findOne({ where: { manual_id: manual.id } });
    const queued = hasText
      ? null
      : await enqueueExtractManual(db, manual.get({ plain: true }), req.user.id);

    const { id, original_name, source, user_id, created_at } = manual;
    res.status(existing ? 200 : 201).json({
      id,
      hash,
      name: manual.name,
      original_name,
      source,
      user_id,
      created_at,
      analysis_scope: manual.analysis_scope,
      has_text: Boolean(hasText),
      job_id: queued ? queued.id : null,
    });
  }));

  // Mark (or unmark) a document as in scope for analysis: in-scope documents
  // are submitted alongside the manual whenever the module is (re)analyzed.
  // Body: { analysis_scope: boolean }. Your own uploads and the shared
  // documents are yours to mark; a document another user merely shared with
  // you is not (and would not be attached to your jobs anyway).
  router.put('/:id/manuals/:manualId/scope', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    if (typeof req.body?.analysis_scope !== 'boolean') {
      return res.status(400).json({ error: 'analysis_scope must be true or false' });
    }
    const manual = await Manual.findOne({
      where: { id: Number(req.params.manualId), module_id: module.id },
    });
    if (!manual || (manual.user_id !== null && manual.user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await manual.update({ analysis_scope: req.body.analysis_scope });
    res.json({ id: manual.id, analysis_scope: manual.analysis_scope });
  }));

  // Remove one of your own uploaded documents (the shared manual cannot be
  // deleted this way).
  router.delete('/:id/manuals/:manualId', asyncHandler(async (req, res) => {
    const manual = await Manual.findOne({
      where: {
        id: Number(req.params.manualId),
        module_id: Number(req.params.id),
        user_id: req.user.id,
      },
    });
    if (!manual) return res.status(404).json({ error: 'Document not found' });
    await manual.destroy();
    await removeShares(db, 'document', manual.id);
    // The file is shared by every record with the same content hash; only
    // remove it once the last reference is gone.
    const remaining = await Manual.count({ where: { hash: manual.hash } });
    if (remaining === 0) fs.rmSync(manualPath(manualsDir, manual.hash), { force: true });
    res.json({ ok: true });
  }));

  return router;
}
