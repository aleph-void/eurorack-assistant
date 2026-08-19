import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findSystemByName } from '../services/racks.js';
import { rackDetailJson } from '../services/rackJson.js';
import { loadPanels } from '../services/panelImage.js';
import { asyncHandler } from './asyncHandler.js';

// A user's systems: collections of racks that are patched together as one
// instrument. A rack still owns its modules and its own row layout; a system
// says which racks stand together, where each one stands in the studio, and
// therefore which jacks a patch may cable to each other.
//
// Systems are private to their owner — every route here operates on the
// requesting user's systems and racks alone.
export function systemRoutes(db) {
  const { System, Rack, RackModule } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const systemJson = (system, { rack_count = 0, module_count = 0 } = {}) => ({
    id: system.id,
    name: system.name,
    description: system.description ?? null,
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

  // Deleting a system keeps its racks — they simply stop being part of one.
  // Patches built from it keep rendering: patches hold the system by a soft
  // reference and by name.
  router.delete('/:id', requireOwnedSystem, asyncHandler(async (req, res) => {
    await req.system.destroy();
    res.json({ ok: true });
  }));

  return router;
}
