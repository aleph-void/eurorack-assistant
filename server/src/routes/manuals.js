import fs from 'node:fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { manualPath, safeManualName } from '../services/pdf.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Documents are retrieved by content hash. A hash is fetchable when a manual
// record visible to the requesting user references it: the shared auto-found
// manual of any module, or one of the user's own uploads.
export function manualRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const { Manual, Module } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // The first document record for the hash the requesting user may see (with
  // its module), plus the file on disk — or null when either is missing.
  async function accessibleManual(req, res) {
    const hash = String(req.params.hash).toLowerCase();
    if (!SHA256_RE.test(hash)) {
      res.status(404).json({ error: 'Document not found' });
      return null;
    }
    const manual = await Manual.findOne({
      where: { hash, [Op.or]: [{ user_id: null }, { user_id: req.user.id }] },
      include: Module,
      order: [['id', 'ASC']],
    });
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
    fs.createReadStream(file).pipe(res);
  }

  router.get('/:hash', async (req, res, next) => {
    try {
      const found = await accessibleManual(req, res);
      if (!found) return;
      const { manual, file } = found;
      sendPdf(res, file, 'inline', manual.original_name || `${manual.hash}.pdf`);
    } catch (e) {
      next(e);
    }
  });

  // Export downloads the document as an attachment named after the module it
  // belongs to and the document's database name.
  router.get('/:hash/export', async (req, res, next) => {
    try {
      const found = await accessibleManual(req, res);
      if (!found) return;
      const { manual, file } = found;
      const module = manual.Module;
      sendPdf(res, file, 'attachment', safeManualName(module.manufacturer, module.name, manual.name));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
