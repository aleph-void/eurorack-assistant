import fs from 'node:fs';
import { Router } from 'express';
import { requireBudget } from '../../services/budgets.js';
import { parseYoutubeId, videoJson, videoWorkDir, youtubeUrl } from '../../services/videos.js';
import { enqueueVideoJob } from '../../jobs/worker.js';
import { requireOwnedModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function moduleVideoRoutes(db, { videosDir }) {
  const { ModuleVideo } = db.models;
  const router = Router();

  // Attach a YouTube video to your module instance. Body: { url }. The link
  // is reduced to its video id and queued for download + analysis; the
  // analysis runs on your LLM account, so the budget gate applies. Posting a
  // link that already failed is the retry: the row is reset and re-queued.
  router.post('/:id/videos', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const videoId = parseYoutubeId(req.body?.url);
    if (!videoId) {
      return res.status(400).json({ error: 'url must be a link to a YouTube video' });
    }
    const existing = await ModuleVideo.findOne({
      where: { module_id: req.module.id, user_id: req.user.id, video_id: videoId },
    });
    if (existing && existing.status !== 'failed') {
      return res.status(409).json({
        error: 'This video is already attached to the module',
        video: videoJson(existing),
      });
    }
    let video = existing;
    if (video) {
      await video.update({ status: 'pending', error: null });
    } else {
      video = await ModuleVideo.create({
        module_id: req.module.id,
        user_id: req.user.id,
        video_id: videoId,
        url: youtubeUrl(videoId),
        status: 'pending',
      });
    }
    const job = await enqueueVideoJob(db, 'download_video', video.get({ plain: true }), req.user.id);
    res.status(existing ? 200 : 201).json({ ...videoJson(video), job_id: job ? job.id : null });
  }));

  // Remove one of your attached videos: the row (link, summary and all) and
  // any work files a failed run left behind.
  router.delete('/:id/videos/:videoId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const video = await ModuleVideo.findOne({
      where: {
        id: Number(req.params.videoId),
        module_id: req.module.id,
        user_id: req.user.id,
      },
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    await video.destroy();
    fs.rmSync(videoWorkDir(videosDir, video), { recursive: true, force: true });
    res.json({ ok: true });
  }));

  return router;
}
