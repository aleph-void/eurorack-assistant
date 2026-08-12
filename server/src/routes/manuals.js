import fs from 'node:fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { manualPath } from '../services/pdf.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Documents are retrieved by content hash. A hash is fetchable when a manual
// record visible to the requesting user references it: the shared auto-found
// manual of any module, or one of the user's own uploads.
export function manualRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const { Manual } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  router.get('/:hash', async (req, res, next) => {
    try {
      const hash = String(req.params.hash).toLowerCase();
      if (!SHA256_RE.test(hash)) return res.status(404).json({ error: 'Document not found' });
      const manual = await Manual.findOne({
        where: { hash, [Op.or]: [{ user_id: null }, { user_id: req.user.id }] },
        order: [['id', 'ASC']],
      });
      const file = manualPath(manualsDir, hash);
      if (!manual || !fs.existsSync(file)) {
        return res.status(404).json({ error: 'Document not found' });
      }
      const name = (manual.original_name || `${hash}.pdf`).replace(/["\\\r\n]/g, '_');
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${name}"`);
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
