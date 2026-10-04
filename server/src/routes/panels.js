// Front-panel images. Like manuals, these belong to the shared module records
// rather than to a user, so any signed-in account may fetch one — but only by
// the content hash of a file some module's panel actually references, so the
// route can never be used to read arbitrary bytes out of the panels directory.

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { STORED_FILE_POLICY } from '../csp.js';
import { IMAGE_TYPES, panelPath } from '../services/image.js';
import { bucketWidth, panelVariant } from '../services/panelThumbs.js';
import { asyncHandler } from './asyncHandler.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

// How many verified names are remembered (below). A studio is a few hundred
// panels; this is more than any one process will be asked for and still a
// few hundred kilobytes if it ever fills.
const VERIFIED_LIMIT = 4096;

// `accelPrefix` is set when nginx has the panels directory mounted and an
// `internal` location over it (nginx.conf, /_panels/): the route then
// answers with an X-Accel-Redirect naming the file under that prefix and no
// body, and nginx sends the bytes itself with sendfile — a 3-8 MB
// manufacturer's original no longer passes through node a chunk at a time.
// The route still decides WHETHER the file is served (the session, the hash
// a panel row names) and WHICH one (the width variant), and still sets the
// headers nginx carries over from the redirect: Content-Type and
// Cache-Control. The ones it does not carry over — the stored-file CSP and
// nosniff — the nginx location adds itself, and tests/csp.test.js holds it
// to the same policy. Unset (the Vite dev proxy, the tests), the bytes are
// streamed from here as before.
export function panelRoutes(
  db,
  { panelsDir = process.env.PANELS_DIR || '/data/panels', accelPrefix = null } = {}
) {
  const { ModulePanel } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // The names some module's panel has been found to reference. A patch page
  // asks for forty of these at once and a zoom asks for them all again, and
  // the answer never changes: a name is a content hash, so a panel row that
  // names it today names the same bytes forever, and a row deleted takes
  // its orphaned bytes with it (services/panelStore.js) — which the stat
  // below still catches. Only a yes is remembered; a no is one query.
  const verified = new Set();
  async function referenced(hash, ext) {
    const name = `${hash}.${ext}`;
    if (verified.has(name)) return true;
    const panel = await ModulePanel.findOne({
      where: { image_hash: hash, image_ext: ext },
      attributes: ['id'],
    });
    if (!panel) return false;
    if (verified.size >= VERIFIED_LIMIT) verified.clear();
    verified.add(name);
    return true;
  }

  router.get('/:file', asyncHandler(async (req, res) => {
    const [hash, ext] = String(req.params.file).toLowerCase().split('.');
    if (!SHA256_RE.test(hash || '') || !IMAGE_TYPES[ext]) {
      return res.status(404).json({ error: 'Panel image not found' });
    }
    const file = panelPath(panelsDir, hash, ext);
    if (!(await referenced(hash, ext)) || !fs.existsSync(file)) {
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
    const served = variant ?? file;
    if (accelPrefix) {
      // The path under the panels directory, as the nginx location's alias
      // sees it: the file itself, or thumbs/<hash>@<width>.webp. Nothing in
      // it needs escaping — a hex hash, a width, an extension this route
      // validated — and nothing is, so nginx has nothing to decode.
      const relative = path.relative(panelsDir, served).split(path.sep).join('/');
      res.set('X-Accel-Redirect', `${accelPrefix}/${relative}`);
      return res.status(200).end();
    }
    // Sized, so the browser can lay the picture's download out and nginx
    // need not chunk it.
    res.set('Content-Length', String((await fs.promises.stat(served)).size));
    fs.createReadStream(served).pipe(res);
  }));

  return router;
}
