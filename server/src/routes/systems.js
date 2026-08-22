import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findSystemByName, rackFootprints, racksOverlap } from '../services/racks.js';
import { rackDetailJson } from '../services/rackJson.js';
import { loadPanels } from '../services/panelJson.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { asyncHandler } from './asyncHandler.js';

// A user's systems: collections of racks that are patched together as one
// instrument. A rack still owns its modules and its own row layout; a system
// says which racks stand together, where each one stands in the studio, and
// therefore which jacks a patch may cable to each other.
//
// Systems are private to their owner — every route here operates on the
// requesting user's systems and racks alone.
// The floor plan a new system starts with, and the most it can be stretched
// to. The maximum matches the ceiling on the coordinates themselves, so a
// rack can always be placed anywhere on the floor its owner made.
export const DEFAULT_FLOOR_WIDTH = 140;
export const DEFAULT_FLOOR_HEIGHT = 9;
export const MIN_FLOOR_WIDTH = 20;
export const MIN_FLOOR_HEIGHT = 3;
export const MAX_FLOOR = 5000;

export function systemRoutes(db) {
  const { Job, System, Rack, RackModule } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const systemJson = (system, { rack_count = 0, module_count = 0 } = {}) => ({
    id: system.id,
    name: system.name,
    description: system.description ?? null,
    // How much floor there is to arrange racks on, in HP across and rack
    // units down — the units the placements themselves are in.
    floor_width: system.floor_width ?? DEFAULT_FLOOR_WIDTH,
    floor_height: system.floor_height ?? DEFAULT_FLOOR_HEIGHT,
    rack_count,
    module_count,
    created_at: system.created_at,
    updated_at: system.updated_at,
  });

  // Route middleware: load the system under :id if this user owns it.
  const requireOwnedSystem = (req, res, next) => {
    System.findOne({ where: { id: Number(req.params.id) || 0, user_id: req.user.id } })
      .then((system) => {
        if (!system) return res.status(404).json({ error: 'System not found' });
        req.system = system;
        next();
      })
      .catch(next);
  };

  // The racks of a system, in the order they are laid out.
  const systemRacks = (systemId) =>
    Rack.findAll({
      where: { system_id: systemId },
      order: [
        ['system_position', 'ASC'],
        ['id', 'ASC'],
      ],
    });

  router.get('/', asyncHandler(async (req, res) => {
    const systems = await System.findAll({
      where: { user_id: req.user.id },
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    if (systems.length === 0) return res.json([]);
    // Rack and module counts, grouped in JS off flat queries (pg-mem drops
    // rows from an OR-ed aggregate, and the app never GROUP BYs for this).
    const racks = await Rack.findAll({
      where: { user_id: req.user.id },
      attributes: ['id', 'system_id'],
    });
    const assigned = racks.filter((rack) => rack.system_id !== null);
    const mappings = assigned.length
      ? await RackModule.findAll({
          where: { rack_id: assigned.map((rack) => rack.id) },
          attributes: ['rack_id'],
        })
      : [];
    const systemOfRack = new Map(assigned.map((rack) => [rack.id, rack.system_id]));
    const rackCounts = new Map();
    for (const rack of assigned) {
      rackCounts.set(rack.system_id, (rackCounts.get(rack.system_id) ?? 0) + 1);
    }
    const moduleCounts = new Map();
    for (const mapping of mappings) {
      const systemId = systemOfRack.get(mapping.rack_id);
      if (systemId === undefined) continue;
      moduleCounts.set(systemId, (moduleCounts.get(systemId) ?? 0) + 1);
    }
    res.json(
      systems.map((system) =>
        systemJson(system, {
          rack_count: rackCounts.get(system.id) ?? 0,
          module_count: moduleCounts.get(system.id) ?? 0,
        })
      )
    );
  }));

  // One system, whole: every rack in it with its inventory and its physical
  // rows, so the floor plan can be drawn from real panels rather than boxes.
  // The user's unassigned racks ride along, since assigning one is the first
  // thing this page is for.
  router.get('/:id', requireOwnedSystem, asyncHandler(async (req, res) => {
    const system = req.system;
    const racks = await systemRacks(system.id);
    const free = await Rack.findAll({
      where: { user_id: req.user.id, system_id: null },
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    // One panel lookup for the whole page rather than one per rack.
    const allRackIds = [...racks, ...free].map((rack) => rack.id);
    const mappings = allRackIds.length
      ? await RackModule.findAll({ where: { rack_id: allRackIds }, attributes: ['module_id'] })
      : [];
    const panels = await loadPanels(db, [...new Set(mappings.map((m) => m.module_id))]);
    const detailed = [];
    for (const rack of racks) detailed.push(await rackDetailJson(db, rack, { panels }));
    const freeJson = [];
    for (const rack of free) freeJson.push(await rackDetailJson(db, rack, { panels }));
    res.json({
      ...systemJson(system, {
        rack_count: detailed.length,
        module_count: detailed.reduce((sum, rack) => sum + rack.module_count, 0),
      }),
      racks: detailed,
      unassigned_racks: freeJson,
    });
  }));

  // Body: { name, description? }
  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (await findSystemByName(db, req.user.id, name)) {
      return res.status(409).json({ error: `you already have a system named '${name}'` });
    }
    const system = await System.create({
      user_id: req.user.id,
      name,
      description: String(req.body?.description || '').trim() || null,
    });
    res.status(201).json(systemJson(system));
  }));

  // Rename / edit description. Body: { name?, description? }
  router.put('/:id', requireOwnedSystem, asyncHandler(async (req, res) => {
    const system = req.system;
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const clash = await findSystemByName(db, req.user.id, name);
      if (clash && clash.id !== system.id) {
        return res.status(409).json({ error: `you already have a system named '${name}'` });
      }
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = String(req.body.description || '').trim() || null;
    }
    // Growing the floor is how a wide studio gets arranged: the plan cannot
    // be dragged into space that is not there. Shrinking is allowed too, and
    // it never moves a rack — the plan simply draws at least as much floor
    // as the racks standing on it need.
    for (const [key, min] of [
      ['floor_width', MIN_FLOOR_WIDTH],
      ['floor_height', MIN_FLOOR_HEIGHT],
    ]) {
      if (req.body?.[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < min || value > MAX_FLOOR) {
        return res.status(400).json({ error: `${key} must be between ${min} and ${MAX_FLOOR}` });
      }
      updates[key] = value;
    }
    await system.update(updates);
    const rackCount = await Rack.count({ where: { system_id: system.id } });
    res.json(systemJson(system, { rack_count: rackCount }));
  }));

  // Where each rack stands on the system's floor plan. Coordinates are HP
  // across and rack-units down — the same units a rack's own rows are
  // measured in — so a rack's box is drawn to scale against its neighbours.
  // Body: { racks: [{ rack_id, x, y }] }, in the order they should stack.
  router.put('/:id/layout', requireOwnedSystem, asyncHandler(async (req, res) => {
    const system = req.system;
    const items = req.body?.racks;
    if (!Array.isArray(items) || items.length > 64) {
      return res.status(400).json({ error: 'racks must be a list of at most 64 racks' });
    }
    const racks = await systemRacks(system.id);
    const byId = new Map(racks.map((rack) => [rack.id, rack]));
    const placements = [];
    const seen = new Set();
    for (const item of items) {
      const rackId = Number(item?.rack_id);
      const rack = byId.get(rackId);
      if (!rack) return res.status(400).json({ error: 'every placement must name a rack in this system' });
      if (seen.has(rackId)) return res.status(400).json({ error: 'a rack can only be placed once' });
      seen.add(rackId);
      const x = Number(item?.x ?? 0);
      const y = Number(item?.y ?? 0);
      if (!Number.isFinite(x) || x < 0 || x > 5000 || !Number.isFinite(y) || y < 0 || y > 5000) {
        return res.status(400).json({ error: 'rack coordinates must be between 0 and 5000' });
      }
      placements.push({ rack, x, y });
    }
    // Two racks cannot stand in the same place. Racks the body leaves out
    // keep the spot they already have and are checked too, or moving one
    // rack could be used to bury another.
    //
    // Only a rack that actually MOVES has to come to rest somewhere free:
    // racks that were already sharing floor (a system arranged before this
    // rule, where everything piled up at the origin) stay allowed exactly
    // where they are, so the way out is to drag them apart one at a time
    // rather than a plan that refuses every save.
    const footprints = await rackFootprints(db, racks.map((rack) => rack.id));
    const standing = racks.map((rack) => {
      const placement = placements.find((item) => item.rack.id === rack.id);
      const x = placement ? placement.x : rack.system_x;
      const y = placement ? placement.y : rack.system_y;
      return {
        name: rack.name,
        x,
        y,
        moved: x !== rack.system_x || y !== rack.system_y,
        ...footprints.get(rack.id),
      };
    });
    for (let i = 0; i < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        if (!standing[i].moved && !standing[j].moved) continue;
        if (racksOverlap(standing[i], standing[j])) {
          return res.status(409).json({
            error: `'${standing[i].name}' and '${standing[j].name}' would overlap — racks cannot stand in the same place`,
          });
        }
      }
    }
    await db.sequelize.transaction(async (transaction) => {
      for (const [position, placement] of placements.entries()) {
        await placement.rack.update(
          { system_x: placement.x, system_y: placement.y, system_position: position },
          { transaction }
        );
      }
    });
    const updated = await systemRacks(system.id);
    res.json({
      racks: updated.map((rack) => ({
        rack_id: rack.id,
        name: rack.name,
        x: rack.system_x,
        y: rack.system_y,
        position: rack.system_position,
      })),
    });
  }));

  // Trim the blank backdrop off EVERY panel in the system's racks, in the
  // background. The cut itself is the same one the module page's Trim button
  // makes (services/panelImage.js) — this is that, asked for once for a whole
  // studio, which is what makes a floor plan drawn from photographs read like
  // the real furniture rather than a wall of white margins.
  //
  // No model runs, so nothing here spends tokens; it still goes to the queue
  // because a system's worth of images is far more than a request should sit
  // on. A panel that is already trimmed is left alone, so pressing this twice
  // costs nothing and eats into no hardware.
  router.post('/:id/panels/trim', requireOwnedSystem, asyncHandler(async (req, res) => {
    const system = req.system;
    // Re-use a queued/running sweep of the same system rather than stacking
    // duplicates (payload is TEXT, so filter the few live rows in JS).
    const live = (
      await Job.findAll({
        where: { type: 'trim_panels', user_id: req.user.id, status: ['pending', 'running'] },
      })
    ).find((job) => {
      try {
        return JSON.parse(job.payload || '{}').system_id === system.id;
      } catch {
        return false;
      }
    });
    const job = live
      ? live.get({ plain: true })
      : await enqueueJob(db, 'trim_panels', {
          userId: req.user.id,
          payload: { system_id: system.id, system_name: system.name },
        });
    res.status(202).json({ id: job.id, type: job.type, status: job.status, reused: !!live });
  }));

  // Deleting a system keeps its racks — they simply stop being part of one.
  // Patches built from it keep rendering: patches hold the system by a soft
  // reference and by name.
  router.delete('/:id', requireOwnedSystem, asyncHandler(async (req, res) => {
    await req.system.destroy();
    res.json({ ok: true });
  }));

  return router;
}
