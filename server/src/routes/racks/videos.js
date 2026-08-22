// Finding a rack's modules on YouTube.
//
// The scan matches a channel's uploads against the rack's module names and
// imports nothing; the import route takes the ones the user picked and puts
// each through the same per-video pipeline a pasted link goes through
// (download_video → analyze_video), on the user's own LLM account.

import { Router } from 'express';
import { enqueueVideoJob } from '../../jobs/worker.js';
import { getConfig } from '../../services/config.js';
import { requireBudget } from '../../services/budgets.js';
import { videoJson, youtubeUrl } from '../../services/videos.js';
import {
  MAX_SCAN_VIDEOS,
  YoutubeError,
  channelRefUrl,
  channelUrl,
  listChannelUploads,
  listChannelViaYtDlp,
  matchVideosToModules,
  parseChannelRef,
  resolveChannel,
} from '../../services/youtube.js';
import { asyncHandler } from '../asyncHandler.js';

import { ownRack } from './helpers.js';

export function rackVideoRoutes(db, { fetchImpl, runImpl } = {}) {
  const { RackModule, Module, ModuleVideo } = db.models;
  const router = Router();

  // Scan a YouTube channel for videos about this rack's modules. Body:
  // { url } — a channel link (/@handle, /channel/UC…, /user/…, /c/…, or a
  // vanity URL), a bare @handle, or a channel id. With an admin-configured
  // key the channel's uploads are listed through the YouTube Data API;
  // without one, yt-dlp lists them keylessly (titles only — flat listings
  // carry no descriptions). Either way the list is matched against the
  // rack's module names; nothing is imported here — the client shows the
  // matches and the user picks which ones the import route below queues.
  router.post('/:id/videos/channel-scan', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const config = await getConfig(db);
    const apiKey = String(config.youtube_api_key || '').trim();
    const ref = parseChannelRef(req.body?.url);
    if (!ref) {
      return res.status(400).json({
        error: 'url must be a YouTube channel link (youtube.com/@handle, /channel/…, /user/… or /c/…)',
      });
    }
    const mappings = await RackModule.findAll({
      where: { rack_id: rack.id },
      include: Module,
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
      ],
    });
    const modules = mappings.filter((rm) => rm.Module).map((rm) => rm.Module);
    let channel;
    let videos;
    try {
      if (apiKey) {
        channel = await resolveChannel(ref, { apiKey, fetchImpl });
        videos = await listChannelUploads(channel, { apiKey, fetchImpl });
      } else {
        ({ channel, videos } = await listChannelViaYtDlp(ref, { run: runImpl }));
      }
    } catch (e) {
      if (e instanceof YoutubeError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const matches = matchVideosToModules(videos, modules);
    // What the user already has of these: the row's pipeline status rides
    // along so a re-scan of the same channel shows each earlier import as
    // analyzed / still in progress / failed, instead of a bare 'attached'.
    const attached = modules.length
      ? await ModuleVideo.findAll({
          where: { user_id: req.user.id, module_id: modules.map((m) => m.id) },
        })
      : [];
    const attachedStatus = new Map(attached.map((v) => [`${v.module_id}:${v.video_id}`, v.status]));
    res.json({
      channel: {
        id: channel.id,
        title: channel.title,
        // yt-dlp can come back without a channel id; the ref's own URL is
        // still a working link.
        url: channel.id ? channelUrl(channel.id) : channelRefUrl(ref),
      },
      // Tells the client to explain titles-only matching on keyless scans.
      source: apiKey ? 'api' : 'yt-dlp',
      scanned: videos.length,
      // A listing that filled the cap probably has older uploads beyond it.
      truncated: videos.length >= MAX_SCAN_VIDEOS,
      modules: modules
        .map((module) => ({
          module_id: module.id,
          manufacturer: module.manufacturer,
          name: module.name,
          videos: (matches.get(module.id) ?? []).map((video) => {
            const status = attachedStatus.get(`${module.id}:${video.video_id}`) ?? null;
            return {
              video_id: video.video_id,
              url: youtubeUrl(video.video_id),
              title: video.title,
              published_at: video.published_at,
              matched_on: video.matched_on,
              // A failed attachment is not 'attached': re-importing it is
              // the retry, so it stays selectable.
              already_attached: status !== null && status !== 'failed',
              attached_status: status,
            };
          }),
        }))
        .filter((module) => module.videos.length > 0),
    });
  }));

  // { videos: [{ module_id, video_id, title? }] }. Each selection becomes an
  // attached module video and goes through the existing pipeline
  // (download_video → analyze_video), so the analysis runs on the user's LLM
  // account and the budget gate applies — exactly as if each link had been
  // pasted on the module page. Already-attached videos are skipped; a failed
  // one is reset and re-queued, like the paste route's retry.
  router.post('/:id/videos/import', requireBudget(db), asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const items = req.body?.videos;
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({ error: 'videos must be a list of 1 to 100 selections' });
    }
    const mappings = await RackModule.findAll({ where: { rack_id: rack.id } });
    const inRack = new Set(mappings.map((rm) => rm.module_id));
    // Validate the whole list before touching anything, so a bad entry never
    // half-imports a selection.
    const selections = [];
    for (const item of items) {
      const moduleId = Number(item?.module_id);
      if (!inRack.has(moduleId)) {
        return res.status(400).json({ error: 'every selection must name a module in this rack' });
      }
      if (!/^[A-Za-z0-9_-]{11}$/.test(item?.video_id ?? '')) {
        return res.status(400).json({ error: 'every selection needs a YouTube video_id' });
      }
      const title = typeof item.title === 'string' ? item.title.trim().slice(0, 300) : '';
      selections.push({ moduleId, videoId: item.video_id, title: title || null });
    }
    let queued = 0;
    let skipped = 0;
    const videos = [];
    for (const { moduleId, videoId, title } of selections) {
      const existing = await ModuleVideo.findOne({
        where: { module_id: moduleId, user_id: req.user.id, video_id: videoId },
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
        // The scan's title is provisional — download_video overwrites it
        // with what yt-dlp reports — but it keeps the row readable while
        // the job is still queued.
        video = await ModuleVideo.create({
          module_id: moduleId,
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

  return router;
}
