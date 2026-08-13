// Front-panel images. Like manuals, these belong to the shared module records
// rather than to a user, so any signed-in account may fetch one — but only by
// the content hash of a file some module's panel actually references, so the
// route can never be used to read arbitrary bytes out of the panels directory.

import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { IMAGE_TYPES, panelPath } from '../services/image.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

export function panelRoutes(db, { panelsDir = process.env.PANELS_DIR || '/data/panels' } = {}) {
  const { ModulePanel } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  router.get('/:file', async (req, res, next) => {
    try {
      const [hash, ext] = String(req.params.file).toLowerCase().split('.');
      if (!SHA256_RE.test(hash || '') || !IMAGE_TYPES[ext]) {
        return res.status(404).json({ error: 'Panel image not found' });
      }
      const panel = await ModulePanel.findOne({ where: { image_hash: hash, image_ext: ext } });
      const file = panelPath(panelsDir, hash, ext);
      if (!panel || !fs.existsSync(file)) {
        return res.status(404).json({ error: 'Panel image not found' });
      }
      res.set('Content-Type', IMAGE_TYPES[ext]);
      // A drawn panel is an SVG we wrote ourselves, but it is still a
      // document: served under a policy that lets it load nothing and run
      // nothing, so it can only ever be a picture.
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.set('X-Content-Type-Options', 'nosniff');
      // The bytes are addressed by their own hash, so they can never change.
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
