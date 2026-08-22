import fs from 'node:fs';
import { Router } from 'express';
import { requireBudget } from '../../services/budgets.js';
import { getConfig } from '../../services/config.js';
import { parseYoutubeId, videoJson, videoWorkDir, youtubeUrl } from '../../services/videos.js';
import {
  MAX_SEARCH_RESULTS,
  YoutubeError,
  moduleSearchQuery,
  searchVideos,
  searchViaYtDlp,
} from '../../services/youtube.js';
import { enqueueVideoJob } from '../../jobs/worker.js';
import { requireOwnedModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function moduleVideoRoutes(db, { videosDir, fetchImpl, runImpl } = {}) {
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

  // Search YouTube for tutorials about this module — the module-detail
  // counterpart of the rack channel scan. The query is built from the
  // module's own name and manufacturer, never from request input. Body:
  // { page? } — the next_page value a previous answer handed back (a
  // search.list token with an API key, a numeric offset keylessly). Nothing
  // is imported here; the client shows the results and the user picks which
  // ones the import route below queues.
  router.post('/:id/videos/search', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const config = await getConfig(db);
    const apiKey = String(config.youtube_api_key || '').trim();
    const query = moduleSearchQuery(req.module);
    const rawPage = req.body?.page;
    const page = rawPage === undefined || rawPage === null ? '' : String(rawPage);
    let videos;
    let nextPage;
    try {
      if (apiKey) {
        if (page && !/^[A-Za-z0-9_=-]{1,128}$/.test(page)) {
          return res.status(400).json({ error: 'page must be the next_page of a previous search' });
        }
        const result = await searchVideos(query, { apiKey, fetchImpl, pageToken: page });
        videos = result.videos;
        nextPage = result.nextPageToken;
      } else {
        const offset = page === '' ? 0 : Number(page);
        if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_SEARCH_RESULTS) {
          return res.status(400).json({ error: 'page must be the next_page of a previous search' });
        }
        const result = await searchViaYtDlp(query, { run: runImpl, offset });
        videos = result.videos;
        nextPage = result.more ? String(offset + videos.length) : null;
      }
    } catch (e) {
      if (e instanceof YoutubeError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    // What the user already has of these: the row's pipeline status rides
    // along so a repeat search shows each earlier import as analyzed / still
    // in progress / failed, instead of a bare 'attached'.
    const attached = await ModuleVideo.findAll({
      where: { module_id: req.module.id, user_id: req.user.id },
    });
    const attachedStatus = new Map(attached.map((v) => [v.video_id, v.status]));
    res.json({
      query,
      // Tells the client to explain titles-only, undated results keylessly.
      source: apiKey ? 'api' : 'yt-dlp',
      videos: videos.map((video) => {
        const status = attachedStatus.get(video.video_id) ?? null;
        return {
          video_id: video.video_id,
          url: youtubeUrl(video.video_id),
          title: video.title,
          channel: video.channel,
          published_at: video.published_at,
          // A failed attachment is not 'attached': re-importing it is the
          // retry, so it stays selectable.
          already_attached: status !== null && status !== 'failed',
          attached_status: status,
        };
      }),
      next_page: nextPage,
    });
  }));

  // Import the search results the user picked. Body:
  // { videos: [{ video_id, title? }] }. Each selection becomes an attached
  // module video and goes through the existing pipeline (download_video →
  // analyze_video), exactly as if each link had been pasted above — so the
  // budget gate applies. Already-attached videos are skipped; a failed one
  // is reset and re-queued, like the paste route's retry.
  router.post('/:id/videos/import', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const items = req.body?.videos;
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({ error: 'videos must be a list of 1 to 100 selections' });
    }
    // Validate the whole list before touching anything, so a bad entry never
    // half-imports a selection.
    const selections = [];
    for (const item of items) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(item?.video_id ?? '')) {
        return res.status(400).json({ error: 'every selection needs a YouTube video_id' });
      }
      const title = typeof item.title === 'string' ? item.title.trim().slice(0, 300) : '';
      selections.push({ videoId: item.video_id, title: title || null });
    }
    let queued = 0;
    let skipped = 0;
    const videos = [];
    for (const { videoId, title } of selections) {
      const existing = await ModuleVideo.findOne({
        where: { module_id: req.module.id, user_id: req.user.id, video_id: videoId },
      });
      if (existing && existing.status !== 'failed') {
        skipped += 1;
        videos.push(videoJson(existing));
        continue;
      }
      let video = existing;
      if (video) {
        await video.update({ status: 'pending', error: null });
      } else {
        // The search's title is provisional — download_video overwrites it
        // with what yt-dlp reports — but it keeps the row readable while
        // the job is still queued.
        video = await ModuleVideo.create({
          module_id: req.module.id,
          user_id: req.user.id,
          video_id: videoId,
          url: youtubeUrl(videoId),
          title,
          status: 'pending',
        });
      }
      await enqueueVideoJob(db, 'download_video', video.get({ plain: true }), req.user.id);
      queued += 1;
      videos.push(videoJson(video));
    }
    res.json({ queued, skipped, videos });
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
