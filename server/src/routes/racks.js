import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findRackByName } from '../services/racks.js';
import { readableResource, removeShares } from '../services/sharing.js';
import { enqueueJob, enqueueVideoJob } from '../jobs/worker.js';
import { loadPanels } from '../services/panelImage.js';
import { getConfig } from '../services/config.js';
import { requireBudget } from '../services/budgets.js';
import { videoJson, youtubeUrl } from '../services/videos.js';
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
} from '../services/youtube.js';
import { asyncHandler } from './asyncHandler.js';

// A user's racks. Every route operates on the requesting user's racks only —
// racks (and their module lists) are never visible to other users.
export function rackRoutes(db, { fetchImpl, runImpl } = {}) {
  const { Rack, RackModule, RackRow, RackRowModule, Module, ModuleVideo, User, Job } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  function ownRack(userId, id) {
    return Rack.findOne({ where: { id: Number(id), user_id: userId } });
  }

  const rackJson = (rack, moduleCount) => ({
    id: rack.id,
    name: rack.name,
    module_count: moduleCount,
    created_at: rack.created_at,
    updated_at: rack.updated_at,
  });

  async function layoutJson(rack, mappings, panels = new Map()) {
    const rows = await RackRow.findAll({ where: { rack_id: rack.id }, order: [['position', 'ASC'], ['id', 'ASC']] });
    const placements = rows.length
      ? await RackRowModule.findAll({ where: { row_id: rows.map((row) => row.id) }, order: [['position', 'ASC'], ['id', 'ASC']] })
      : [];
    const modules = new Map(
      mappings.filter((mapping) => mapping.Module).map((mapping) => [mapping.module_id, mapping.Module])
    );
    return rows.map((row) => ({
      id: row.id,
      unit: row.unit,
      hp: row.hp,
      position: row.position,
      modules: placements
        .filter((placement) => placement.row_id === row.id)
        .map((placement) => {
          const module = modules.get(placement.module_id);
          return module
            ? {
                id: placement.id,
                module_id: module.id,
                manufacturer: module.manufacturer,
                name: module.name,
                hp: module.hp,
                panel: panels.get(module.id) ?? null,
                position: placement.position,
              }
            : null;
        })
        .filter(Boolean),
    }));
  }

  router.get('/', asyncHandler(async (req, res) => {
    const racks = await Rack.findAll({
      where: { user_id: req.user.id },
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    // Module counts, grouped in JS (pg-mem-friendly flat query).
    const mappings =
      racks.length === 0
        ? []
        : await RackModule.findAll({ where: { rack_id: racks.map((r) => r.id) } });
    const counts = new Map();
    for (const m of mappings) counts.set(m.rack_id, (counts.get(m.rack_id) ?? 0) + 1);
    res.json(racks.map((r) => rackJson(r, counts.get(r.id) ?? 0)));
  }));

  // One rack and what is in it: yours, or one somebody shared with you. This
  // is the whole of a shared rack — the module list, as it stands — and it is
  // read-only, every other route here being the owner's alone.
  router.get('/:id', asyncHandler(async (req, res) => {
    const found = await readableResource(db, req.user.id, 'rack', req.params.id);
    if (!found) return res.status(404).json({ error: 'Rack not found' });
    const rack = found.row;
    const mappings = await RackModule.findAll({
      where: { rack_id: rack.id },
      include: Module,
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
      ],
    });
    const owner = found.shared ? await User.findByPk(rack.user_id) : null;
    const panels = await loadPanels(db, mappings.map((mapping) => mapping.module_id));
    res.json({
      ...rackJson(rack, mappings.length),
      shared: found.shared,
      owner_username: owner?.username ?? req.user.username,
      modules: mappings
        .filter((rm) => rm.Module)
        .map((rm) => ({
          id: rm.Module.id,
          manufacturer: rm.Module.manufacturer,
          name: rm.Module.name,
          hp: rm.Module.hp,
          panel: panels.get(rm.Module.id) ?? null,
          summary: rm.Module.summary,
          quantity: rm.quantity,
        })),
      rows: await layoutJson(rack, mappings, panels),
    });
  }));

  // Body: { name }
  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (await findRackByName(db, req.user.id, name)) {
      return res.status(409).json({ error: `you already have a rack named '${name}'` });
    }
    const rack = await Rack.create({ user_id: req.user.id, name });
    res.status(201).json(rackJson(rack, 0));
  }));

  // Rename. Body: { name }
  router.put('/:id', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const clash = await findRackByName(db, req.user.id, name);
    if (clash && clash.id !== rack.id) {
      return res.status(409).json({ error: `you already have a rack named '${name}'` });
    }
    await rack.update({ name });
    const moduleCount = await RackModule.count({ where: { rack_id: rack.id } });
    res.json(rackJson(rack, moduleCount));
  }));

  // Replace the physical layout of a rack. Rack modules remain the inventory;
  // every placement here consumes one copy from that inventory.
  // Body: { rows: [{ unit: 1|3, hp, modules: [{ module_id }] }] }
  router.put('/:id/layout', async (req, res, next) => {
    try {
      const rack = await ownRack(req.user.id, req.params.id);
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      const rows = req.body?.rows;
      if (!Array.isArray(rows) || rows.length > 24) {
        return res.status(400).json({ error: 'rows must be a list of at most 24 rows' });
      }
      const mappings = await RackModule.findAll({ where: { rack_id: rack.id }, include: Module });
      const inventory = new Map(mappings.map((mapping) => [mapping.module_id, mapping.quantity]));
      const modules = new Map(mappings.filter((mapping) => mapping.Module).map((mapping) => [mapping.module_id, mapping.Module]));
      const placed = new Map();
      const normalized = [];
      for (let index = 0; index < rows.length; index += 1) {
        const raw = rows[index] || {};
        const unit = Number(raw.unit);
        const hp = Number(raw.hp);
        if (unit !== 1 && unit !== 3) return res.status(400).json({ error: 'row unit must be 1 or 3' });
        if (!Number.isFinite(hp) || hp <= 0 || hp > 504) {
          return res.status(400).json({ error: 'row hp must be between 1 and 504' });
        }
        if (!Array.isArray(raw.modules) || raw.modules.length > 128) {
          return res.status(400).json({ error: 'row modules must be a list of at most 128 modules' });
        }
        let used = 0;
        const rowModules = raw.modules.map((item) => {
          // `module_id` is the layout wire format; accepting `id` as well
          // keeps hand-written/older organizer requests from losing a valid
          // rack module.
          const moduleId = Number(item?.module_id ?? item?.id);
          const module = modules.get(moduleId);
          if (!module) throw new Error('A placed module is not in this rack');
          const moduleHp = Number(module.hp);
          if (!Number.isFinite(moduleHp) || moduleHp <= 0) {
            throw new Error(`${module.manufacturer} ${module.name} needs an HP width before it can be placed`);
          }
          const count = (placed.get(moduleId) ?? 0) + 1;
          if (count > (inventory.get(moduleId) ?? 0)) throw new Error('A module is placed more times than this rack contains it');
          placed.set(moduleId, count);
          used += moduleHp;
          return { module_id: moduleId };
        });
        if (used > hp + 0.001) return res.status(400).json({ error: `row ${index + 1} exceeds its ${hp}HP capacity` });
        normalized.push({ unit, hp, modules: rowModules.map((module, position) => ({ ...module, position })) });
      }
      await db.sequelize.transaction(async (transaction) => {
        await RackRow.destroy({ where: { rack_id: rack.id }, transaction });
        for (const [position, row] of normalized.entries()) {
          const created = await RackRow.create({ rack_id: rack.id, unit: row.unit, hp: row.hp, position }, { transaction });
          if (row.modules.length) {
            await RackRowModule.bulkCreate(row.modules.map((module) => ({ ...module, row_id: created.id })), { transaction });
          }
        }
      });
      const panels = await loadPanels(db, mappings.map((mapping) => mapping.module_id));
      res.json({ rows: await layoutJson(rack, mappings, panels) });
    } catch (e) {
      if (e.message?.includes('placed module') || e.message?.includes('needs an HP') || e.message?.includes('more times')) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  // Deleting a rack removes the rack and its module mappings. The module
  // records themselves are kept, in no rack at all if this was their last
  // one, so that importing them again restores the manual, analysis and
  // panel work rather than repeating it.
  router.delete('/:id', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    await rack.destroy();
    await removeShares(db, 'rack', rack.id);
    res.json({ ok: true });
  }));

  // Queue a background export of everything about the rack's modules —
  // manual PDFs plus the user's notes and questions rendered to PDF — into
  // one zip. The client auto-downloads the zip when the job's 'completed'
  // event arrives over the WebSocket (the link also shows on the Jobs page).
  router.post('/:id/export', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    // Re-use a queued/running export of the same rack instead of stacking
    // duplicates (payload is TEXT, so filter the few live rows in JS).
    const live = (
      await Job.findAll({
        where: { type: 'export_rack', user_id: req.user.id, status: ['pending', 'running'] },
      })
    ).find((j) => {
      try {
        return JSON.parse(j.payload || '{}').rack_id === rack.id;
      } catch {
        return false;
      }
    });
    const job = live
      ? live.get({ plain: true })
      : await enqueueJob(db, 'export_rack', {
          userId: req.user.id,
          payload: { rack_id: rack.id, rack_name: rack.name },
        });
    res.status(202).json({ id: job.id, type: job.type, status: job.status, reused: !!live });
  }));

  // Scan a YouTube channel for videos about this rack's modules. Body:
  // { url } — a channel link (/@handle, /channel/UC…, /user/…, /c/…, or a
  // vanity URL), a bare @handle, or a channel id. With an admin-configured
  // key the channel's uploads are listed through the YouTube Data API;
  // without one, yt-dlp lists them keylessly (titles only — flat listings
  // carry no descriptions). Either way the list is matched against the
  // rack's module names; nothing is imported here — the client shows the
  // matches and the user picks which ones the import route below queues.
  router.post('/:id/videos/channel-scan', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
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

  // Import the channel videos the user picked from a scan. Body:
  // { videos: [{ module_id, video_id, title? }] }. Each selection becomes an
  // attached module video and goes through the existing pipeline
  // (download_video → analyze_video), so the analysis runs on the user's LLM
  // account and the budget gate applies — exactly as if each link had been
  // pasted on the module page. Already-attached videos are skipped; a failed
  // one is reset and re-queued, like the paste route's retry.
  router.post('/:id/videos/import', requireBudget(db), asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
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

  // Move a module from this rack to another of the user's racks. If the
  // target rack already has the module, the quantities merge.
  // Body: { to_rack_id }
  router.post('/:id/modules/:moduleId/move', asyncHandler(async (req, res) => {
    const toId = Number(req.body?.to_rack_id);
    if (!Number.isInteger(toId) || toId <= 0) {
      return res.status(400).json({ error: 'to_rack_id is required' });
    }
    const from = await ownRack(req.user.id, req.params.id);
    const to = await ownRack(req.user.id, toId);
    if (!from || !to) return res.status(404).json({ error: 'Rack not found' });
    if (from.id === to.id) {
      return res.status(400).json({ error: 'to_rack_id must be a different rack' });
    }
    const moduleId = Number(req.params.moduleId);
    const source = await RackModule.findOne({
      where: { rack_id: from.id, module_id: moduleId },
    });
    if (!source) return res.status(404).json({ error: 'Module not found in this rack' });

    // Remove-from-source and add-to-target commit or roll back together.
    await db.sequelize.transaction(async (transaction) => {
      const target = await RackModule.findOne({
        where: { rack_id: to.id, module_id: moduleId },
        transaction,
      });
      if (target) {
        await target.update({ quantity: target.quantity + source.quantity }, { transaction });
      } else {
        await RackModule.create(
          { rack_id: to.id, module_id: moduleId, quantity: source.quantity },
          { transaction }
        );
      }
      await source.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  // Set how many copies of a module this rack contains. Body: { quantity }.
  // Rack modules are the inventory the layout consumes, so shrinking below
  // the number already placed also removes the excess placements (highest
  // positions first) to keep the layout within the inventory.
  router.put('/:id/modules/:moduleId', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ error: 'quantity must be a whole number between 1 and 99' });
    }
    const mapping = await RackModule.findOne({
      where: { rack_id: rack.id, module_id: Number(req.params.moduleId) },
    });
    if (!mapping) return res.status(404).json({ error: 'Module not found in this rack' });
    const rows = await RackRow.findAll({ where: { rack_id: rack.id } });
    const placements =
      rows.length === 0
        ? []
        : await RackRowModule.findAll({
            where: { row_id: rows.map((row) => row.id), module_id: mapping.module_id },
            order: [
              ['position', 'DESC'],
              ['id', 'DESC'],
            ],
          });
    const excess = placements.slice(0, Math.max(0, placements.length - quantity));
    await db.sequelize.transaction(async (transaction) => {
      await mapping.update({ quantity }, { transaction });
      for (const placement of excess) await placement.destroy({ transaction });
    });
    res.json({ ok: true, quantity });
  }));

  return router;
}
