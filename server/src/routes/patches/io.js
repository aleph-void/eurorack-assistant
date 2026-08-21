import { Router } from 'express';
import { patchJson } from '../../services/patchDetail.js';
import {
  DocumentError,
  exportPatchDocument,
  importPatchDocument,
  parsePatchDocument,
  patchFileName,
} from '../../services/patchIO.js';
import { isNameConflict, nameTakenMessage, patchNamed } from '../../services/patchNames.js';
import { requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// Patches as files: import a patch document, export a patch to one.
export function patchIoRoutes(db) {
  const {
    Rack,
  } = db.models;
  const router = Router();

  // ---- patches as files ----

  // Read a patch back in from a file written by the export below — from this
  // install or another one. Body: the document, or { document, name?,
  // rack_id? }.
  //
  // Names are resolved against the modules the importing user has; the rest
  // come in by name and are listed in the response. Nothing is created for
  // them, and nothing is imported halfway: the whole patch is one transaction.
  router.post('/import', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const raw = body.document ?? body.patch_document ?? body;
    let document;
    try {
      document = parsePatchDocument(raw);
    } catch (e) {
      if (e instanceof DocumentError) return res.status(400).json({ error: e.message });
      throw e;
    }
    if (document.modules.length === 0) {
      return res.status(400).json({ error: 'this file has no modules in it' });
    }

    // Filing it against one of your racks is optional: a patch from
    // somebody else's rack still reads, it just belongs to no rack of yours.
    let rack = null;
    if (body.rack_id !== undefined && body.rack_id !== null && body.rack_id !== '') {
      rack = await Rack.findOne({
        where: { id: Number(body.rack_id) || 0, user_id: req.user.id },
      });
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
    }

    const name = String(body.name || '').trim() || null;
    // A name the importer chose has to be one they can have; a file read in
    // under its own name takes the next free one instead (patchNames.js).
    if (name && (await patchNamed(db, req.user.id, name))) {
      return res.status(409).json({ error: nameTakenMessage(name) });
    }
    const runImport = () =>
      importPatchDocument(db, { userId: req.user.id, document, rack, name });
    let imported;
    try {
      imported = await runImport();
    } catch (e) {
      if (!isNameConflict(e)) throw e;
      // Another request took the name between choosing it and writing it. A
      // name the importer typed is theirs to change; one the app picked out
      // of the file is simply picked again.
      if (name) return res.status(409).json({ error: nameTakenMessage(name) });
      imported = await runImport();
    }
    const { patch, counts, unresolved_modules: unresolved } = imported;
    res.status(201).json(
      patchJson(patch, {
        module_count: counts.modules,
        cable_count: counts.cables,
        imported: counts,
        unresolved_modules: unresolved,
      })
    );
  }));

  // The patch as a JSON file: every instance, cable, setting, bus and link,
  // written in names rather than ids so it can be read anywhere. Yours only —
  // a patch shared with you is yours to read, not to take a copy of.
  router.get('/:id/export', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const document = await exportPatchDocument(db, patch);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="${patchFileName(patch).replace(/["\\\r\n]/g, '_')}"`
    );
    res.send(JSON.stringify(document, null, 2));
  }));

  return router;
}
