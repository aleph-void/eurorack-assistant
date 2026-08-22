// A rack itself: the list, one rack and what is in it, creating, renaming,
// joining a system, deleting, and taking one away as a zip.

import { Router } from 'express';
import { findRackByName, freePlacement, rackFootprints } from '../../services/racks.js';
import { rackDetailJson, rackJson } from '../../services/rackJson.js';
import { readableResource, removeShares } from '../../services/sharing.js';
import { enqueueJob } from '../../jobs/worker.js';
import { asyncHandler } from '../asyncHandler.js';

import { ownRack } from './helpers.js';

export function rackCoreRoutes(db) {
  const { Rack, RackModule, System, User, Job } = db.models;
  const router = Router();

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
    const rack = await ownRack(db, req.user.id, req.params.id);
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
    const rack = await ownRack(db, req.user.id, req.params.id);
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
    // A rack joining a system lands after the ones already in it, and on
    // free floor beside them rather than on top of them — two racks may
    // never stand in the same place, and a newcomer piled at the origin
    // would be exactly that.
    const siblings = await Rack.findAll({ where: { system_id: system.id } });
    const position = siblings.reduce((max, r) => Math.max(max, r.system_position + 1), 0);
    const joining = rack.system_id !== system.id;
    const updates = { system_id: system.id, system_position: joining ? position : rack.system_position };
    if (joining) {
      const others = siblings.filter((r) => r.id !== rack.id);
      const footprints = await rackFootprints(db, [rack.id, ...others.map((r) => r.id)]);
      const spot = freePlacement(
        others.map((r) => ({ x: r.system_x, y: r.system_y, ...footprints.get(r.id) })),
        footprints.get(rack.id)
      );
      updates.system_x = spot.x;
      updates.system_y = spot.y;
    }
    await rack.update(updates);
    res.json(rackJson(rack, await RackModule.count({ where: { rack_id: rack.id } })));
  }));

  // Deleting a rack removes the rack and its module mappings. The module
  // records themselves are kept, in no rack at all if this was their last
  // one, so that importing them again restores the manual, analysis and
  // panel work rather than repeating it.
  router.delete('/:id', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
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
    const rack = await ownRack(db, req.user.id, req.params.id);
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

  return router;
}
