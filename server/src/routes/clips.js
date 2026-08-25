// Stored oscilloscope video clips. Strictly private, like captures: a clip
// is a recording of the user's own bench, so every lookup is scoped to the
// owner — the module it hangs off may be shared, the clip never is.

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  CLIP_FORMATS,
  clipJson,
  clipPath,
  deleteClipVideoIfOrphaned,
} from '../services/clips.js';
import { asyncHandler } from './asyncHandler.js';

export function clipRoutes(
  db,
  { capturesDir = process.env.CAPTURES_DIR || '/data/captures' } = {}
) {
  const { ScopeClip, ScopeClipChannel } = db.models;
  const clipsDir = path.join(capturesDir, 'clips');
  const router = Router();
  router.use(requireAuth(db));

  const ownClip = (userId, id) =>
    ScopeClip.findOne({ where: { id: Number(id) || 0, user_id: userId } });

  async function withChannels(clips) {
    const ids = clips.map((c) => c.id);
    const channels =
      ids.length === 0
        ? []
        : await ScopeClipChannel.findAll({
            where: { clip_id: ids },
            order: [['channel_index', 'ASC']],
          });
    return clips.map((clip) =>
      clipJson(
        clip,
        channels.filter((c) => c.clip_id === clip.id)
      )
    );
  }

  // Optional filters: ?module_id= / ?patch_id=
  router.get('/', asyncHandler(async (req, res) => {
    const where = { user_id: req.user.id };
    if (req.query.module_id) where.module_id = Number(req.query.module_id) || 0;
    if (req.query.patch_id) where.patch_id = Number(req.query.patch_id) || 0;
    const clips = await ScopeClip.findAll({ where, order: [['id', 'DESC']] });
    res.json(await withChannels(clips));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const clip = await ownClip(req.user.id, req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const [json] = await withChannels([clip]);
    res.json(json);
  }));

  router.get('/:id/video', asyncHandler(async (req, res) => {
    const clip = await ownClip(req.user.id, req.params.id);
    if (!clip || !clip.video_hash || !CLIP_FORMATS[clip.video_format]) {
      return res.status(404).json({ error: 'Clip not found' });
    }
    const file = clipPath(clipsDir, clip.video_hash, clip.video_format);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Clip video not found' });
    res.set('Content-Type', CLIP_FORMATS[clip.video_format].mime);
    // The bytes are addressed by their own hash, so they can never change.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  }));

  // Body: { title?, caption? }
  router.put('/:id', asyncHandler(async (req, res) => {
    const clip = await ownClip(req.user.id, req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const values = {};
    if (req.body?.title !== undefined) {
      values.title = String(req.body.title).trim().slice(0, 200) || null;
    }
    if (req.body?.caption !== undefined) {
      values.caption = String(req.body.caption).trim().slice(0, 2000) || null;
    }
    await clip.update(values);
    const [json] = await withChannels([clip]);
    res.json(json);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const clip = await ownClip(req.user.id, req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const { video_hash: hash, video_format: format } = clip;
    await clip.destroy();
    // The file goes only once nothing else points at those bytes.
    await deleteClipVideoIfOrphaned(db, clipsDir, hash, format);
    res.json({ ok: true });
  }));

  return router;
}
