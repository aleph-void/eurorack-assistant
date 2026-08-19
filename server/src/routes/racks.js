import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findRackByName } from '../services/racks.js';
import { layoutJson, rackDetailJson, rackJson } from '../services/rackJson.js';
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
  const { Rack, RackModule, RackRow, RackRowModule, Module, ModuleVideo, System, User, Job } =
    db.models;
  const router = Router();
  router.use(requireAuth(db));

  function ownRack(userId, id) {
    return Rack.findOne({ where: { id: Number(id), user_id: userId } });
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
    const owner = found.shared ? await User.findByPk(rack.user_id) : null;
    const detail = await rackDetailJson(db, rack);
    // Sharing a rack shares the rack. Which system its owner keeps it in, and
    // where it stands in their studio, is about the rest of their gear and is
    // not part of what was handed over.
    if (found.shared) {
      delete detail.system_id;
      delete detail.system_x;
      delete detail.system_y;
      delete detail.system_position;
    }
    res.json({
      ...detail,
      shared: found.shared,
      owner_username: owner?.username ?? req.user.username,
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

  // Put this rack into one of the user's systems, or take it out of the one
  // it is in. Racks own their modules either way; a system only groups them.
  // Body: { system_id } — null or empty takes the rack out.
  router.put('/:id/system', asyncHandler(async (req, res) => {
    const rack = await ownRack(req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const raw = req.body?.system_id;
    if (raw === null || raw === undefined || raw === '') {
      await rack.update({ system_id: null, system_x: 0, system_y: 0, system_position: 0 });
      return res.json(rackJson(rack, await RackModule.count({ where: { rack_id: rack.id } })));
    }
    const system = await System.findOne({
      where: { id: Number(raw) || 0, user_id: req.user.id },
    });
    if (!system) return res.status(404).json({ error: 'System not found' });
    // A rack joining a system lands after the ones already in it, so its box
    // does not sit on top of another until the user drags it somewhere.
    const siblings = await Rack.findAll({ where: { system_id: system.id } });
    const position = siblings.reduce((max, r) => Math.max(max, r.system_position + 1), 0);
    await rack.update({
      system_id: system.id,
      system_position: rack.system_id === system.id ? rack.system_position : position,
    });
    res.json(rackJson(rack, await RackModule.count({ where: { rack_id: rack.id } })));
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
      res.json({ rows: await layoutJson(db, rack, mappings, panels) });
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

  // Drop a rack's physical placements of a module down to `keep` of them,
  // highest positions first. rack_modules is the inventory a layout draws
  // from, so a rack can never stand more copies in its rows than it holds:
  // both shrinking the quantity and moving copies out come through here.
  async function trimPlacements(rackId, moduleId, keep, transaction) {
    const rows = await RackRow.findAll({ where: { rack_id: rackId }, transaction });
    if (rows.length === 0) return;
    const placements = await RackRowModule.findAll({
      where: { row_id: rows.map((row) => row.id), module_id: moduleId },
      order: [
        ['position', 'DESC'],
        ['id', 'DESC'],
      ],
      transaction,
    });
    const excess = placements.slice(0, Math.max(0, placements.length - keep));
    for (const placement of excess) await placement.destroy({ transaction });
  }

  // Move copies of a module out of `from` and into `to`, merging with what
  // the target rack already holds. `count` is how many copies go; null moves
  // the lot. The copies that leave take the source rack's physical
  // placements of them with them, so what stands in its rows never exceeds
  // what it still holds.
  async function moveModule(from, to, moduleId, transaction, count = null) {
    const source = await RackModule.findOne({
      where: { rack_id: from.id, module_id: moduleId },
      transaction,
    });
    if (!source) return false;
    const moving = count === null ? source.quantity : Math.min(count, source.quantity);
    if (moving < 1) return false;
    const target = await RackModule.findOne({
      where: { rack_id: to.id, module_id: moduleId },
      transaction,
    });
    if (target) {
      await target.update({ quantity: target.quantity + moving }, { transaction });
    } else {
      await RackModule.create(
        { rack_id: to.id, module_id: moduleId, quantity: moving },
        { transaction }
      );
    }
    const left = source.quantity - moving;
    if (left > 0) await source.update({ quantity: left }, { transaction });
    else await source.destroy({ transaction });
    await trimPlacements(from.id, moduleId, left, transaction);
    return true;
  }

  // The two racks a move runs between, or the response that says why not.
  async function moveEnds(req, res, toId) {
    if (!Number.isInteger(toId) || toId <= 0) {
      res.status(400).json({ error: 'to_rack_id is required' });
      return null;
    }
    const from = await ownRack(req.user.id, req.params.id);
    const to = await ownRack(req.user.id, toId);
    if (!from || !to) {
      res.status(404).json({ error: 'Rack not found' });
      return null;
    }
    if (from.id === to.id) {
      res.status(400).json({ error: 'to_rack_id must be a different rack' });
      return null;
    }
    return { from, to };
  }

  // Move a module from this rack to another of the user's racks. If the
  // target rack already has the module, the quantities merge.
  // Body: { to_rack_id, quantity? } — quantity moves only some of the copies
  // this rack holds and leaves the rest behind, so two of the same module can
  // be split between racks; omitted, the whole holding moves.
  router.post('/:id/modules/:moduleId/move', asyncHandler(async (req, res) => {
    const ends = await moveEnds(req, res, Number(req.body?.to_rack_id));
    if (!ends) return;
    const moduleId = Number(req.params.moduleId);
    const source = await RackModule.findOne({
      where: { rack_id: ends.from.id, module_id: moduleId },
    });
    if (!source) return res.status(404).json({ error: 'Module not found in this rack' });
    const asked = req.body?.quantity;
    let count = null;
    if (asked !== undefined && asked !== null && asked !== '') {
      count = Number(asked);
      if (!Number.isInteger(count) || count < 1 || count > source.quantity) {
        return res.status(400).json({
          error: `quantity must be a whole number between 1 and ${source.quantity}`,
        });
      }
    }
    // Remove-from-source and add-to-target commit or roll back together.
    await db.sequelize.transaction((transaction) =>
      moveModule(ends.from, ends.to, moduleId, transaction, count)
    );
    const moved = count ?? source.quantity;
    res.json({ ok: true, moved, left: source.quantity - moved });
  }));

  // Reorganizing a case is a job of many modules at once, not one dropdown at
  // a time. Same rules as the single move, applied to a list — and the whole
  // list is checked before anything is written, so a mistyped id moves
  // nothing rather than half of them.
  // Body: { to_rack_id, module_ids: [...], quantities?: { <module_id>: n } }
  // A module with a quantity sends only that many copies and leaves the rest
  // in this rack; one without sends everything the rack holds of it.
  router.post('/:id/modules/move', asyncHandler(async (req, res) => {
    const ends = await moveEnds(req, res, Number(req.body?.to_rack_id));
    if (!ends) return;
    const ids = req.body?.module_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
      return res.status(400).json({ error: 'module_ids must be a list of 1 to 200 modules' });
    }
    const moduleIds = [...new Set(ids.map((id) => Number(id)))];
    if (moduleIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'every module id must be a whole number' });
    }
    const held = await RackModule.findAll({
      where: { rack_id: ends.from.id, module_id: moduleIds },
      attributes: ['module_id', 'quantity'],
    });
    const inRack = new Map(held.map((rm) => [rm.module_id, rm.quantity]));
    const missing = moduleIds.filter((id) => !inRack.has(id));
    if (missing.length > 0) {
      return res.status(404).json({
        error: `${missing.length} of the selected module(s) are not in this rack`,
      });
    }
    const asked = req.body?.quantities ?? {};
    const counts = new Map();
    for (const moduleId of moduleIds) {
      const want = asked[moduleId];
      if (want === undefined || want === null || want === '') continue;
      const count = Number(want);
      if (!Number.isInteger(count) || count < 1 || count > inRack.get(moduleId)) {
        return res.status(400).json({
          error:
            `how many to move must be a whole number between 1 and ` +
            `${inRack.get(moduleId)} for each selected module`,
        });
      }
      counts.set(moduleId, count);
    }
    let copies = 0;
    await db.sequelize.transaction(async (transaction) => {
      for (const moduleId of moduleIds) {
        const count = counts.get(moduleId) ?? null;
        copies += count ?? inRack.get(moduleId);
        await moveModule(ends.from, ends.to, moduleId, transaction, count);
      }
    });
    res.json({ ok: true, moved: moduleIds.length, copies, to_rack_id: ends.to.id });
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
    await db.sequelize.transaction(async (transaction) => {
      await mapping.update({ quantity }, { transaction });
      await trimPlacements(rack.id, mapping.module_id, quantity, transaction);
    });
    res.json({ ok: true, quantity });
  }));

  return router;
}
