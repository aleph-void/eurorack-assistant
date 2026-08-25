// Front-panel images. Like manuals, these belong to the shared module records
// rather than to a user, so any signed-in account may fetch one — but only by
// the content hash of a file some module's panel actually references, so the
// route can never be used to read arbitrary bytes out of the panels directory.

import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { STORED_FILE_POLICY } from '../csp.js';
import { IMAGE_TYPES, panelPath } from '../services/image.js';
import { bucketWidth, panelVariant } from '../services/panelThumbs.js';
import { asyncHandler } from './asyncHandler.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

export function panelRoutes(db, { panelsDir = process.env.PANELS_DIR || '/data/panels' } = {}) {
  const { ModulePanel } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  router.get('/:file', asyncHandler(async (req, res) => {
    const [hash, ext] = String(req.params.file).toLowerCase().split('.');
    if (!SHA256_RE.test(hash || '') || !IMAGE_TYPES[ext]) {
      return res.status(404).json({ error: 'Panel image not found' });
    }
    const panel = await ModulePanel.findOne({ where: { image_hash: hash, image_ext: ext } });
    const file = panelPath(panelsDir, hash, ext);
    if (!panel || !fs.existsSync(file)) {
      return res.status(404).json({ error: 'Panel image not found' });
    }
    // ?w=<pixels> asks for the picture at the size it is about to be drawn
    // rather than the size it was published at (services/panelThumbs.js). A
    // width nothing can be rendered for — no sharp, a vector, a moving GIF,
    // or one bigger than any variant — falls back to the original, which is
    // always correct and only ever slower.
    const width = bucketWidth(req.query.w);
    const variant = width ? await panelVariant(panelsDir, hash, ext, width) : null;
    res.set('Content-Type', variant ? IMAGE_TYPES.webp : IMAGE_TYPES[ext]);
    // A drawn panel is an SVG we wrote ourselves, but it is still a
    // document: served under a policy that lets it load nothing and run
    // nothing, so it can only ever be a picture.
    res.set('Content-Security-Policy', STORED_FILE_POLICY);
    res.set('X-Content-Type-Options', 'nosniff');
    // The bytes are addressed by their own hash, so they can never change.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(variant ?? file).pipe(res);
  }));

  return router;
}
