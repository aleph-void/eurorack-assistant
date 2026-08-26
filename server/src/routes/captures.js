// Stored waveform captures. Strictly private: a capture is a picture of the
// user's own bench, filed under their own note, so unlike manuals there is no
// shared-visibility case here — every lookup is scoped to the owner.

import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { capturePath, deleteCaptureImageIfOrphaned } from '../services/captures.js';
import { asyncHandler } from './asyncHandler.js';

export function captureRoutes(
  db,
  { capturesDir = process.env.CAPTURES_DIR || '/data/captures' } = {}
) {
  const { Capture, CaptureChannel } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const ownCapture = (userId, id) =>
    Capture.findOne({ where: { id: Number(id) || 0, user_id: userId } });

  async function withChannels(captures) {
    const ids = captures.map((c) => c.id);
    const channels =
      ids.length === 0
        ? []
        : await CaptureChannel.findAll({
            where: { capture_id: ids },
            order: [['channel_index', 'ASC']],
          });
    return captures.map((capture) => ({
      ...capture.get({ plain: true }),
      channels: channels
        .filter((c) => c.capture_id === capture.id)
        .map((c) => c.get({ plain: true })),
    }));
  }

  // Optional filters: ?patch_id= / ?module_id= / ?note_id=
  router.get('/', asyncHandler(async (req, res) => {
    const where = { user_id: req.user.id };
    if (req.query.patch_id) where.patch_id = Number(req.query.patch_id) || 0;
    if (req.query.module_id) where.module_id = Number(req.query.module_id) || 0;
    if (req.query.note_id) where.note_id = Number(req.query.note_id) || 0;
    const captures = await Capture.findAll({ where, order: [['id', 'DESC']] });
    res.json(await withChannels(captures));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const capture = await ownCapture(req.user.id, req.params.id);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    const [json] = await withChannels([capture]);
    res.json(json);
  }));

  router.get('/:id/image', asyncHandler(async (req, res) => {
    const capture = await ownCapture(req.user.id, req.params.id);
    if (!capture || !capture.image_hash) {
      return res.status(404).json({ error: 'Capture not found' });
    }
    const file = capturePath(capturesDir, capture.image_hash);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Capture image not found' });
    res.set('Content-Type', 'image/png');
    // The bytes are addressed by their own hash, so they can never change.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  }));

  // Body: { title?, caption? }
  router.put('/:id', asyncHandler(async (req, res) => {
    const capture = await ownCapture(req.user.id, req.params.id);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    const values = {};
    if (req.body?.title !== undefined) {
      values.title = String(req.body.title).trim().slice(0, 200) || null;
    }
    if (req.body?.caption !== undefined) {
      values.caption = String(req.body.caption).trim().slice(0, 2000) || null;
    }
    await capture.update(values);
    const [json] = await withChannels([capture]);
    res.json(json);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const capture = await ownCapture(req.user.id, req.params.id);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    const hash = capture.image_hash;
    await capture.destroy();
    // The file goes only once nothing else points at those bytes.
    await deleteCaptureImageIfOrphaned(db, capturesDir, hash);
    res.json({ ok: true });
  }));

  return router;
}
