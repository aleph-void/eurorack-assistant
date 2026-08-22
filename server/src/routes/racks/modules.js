// Moving modules between racks, and how many copies a rack holds.
//
// rack_modules is the INVENTORY a layout draws from, so neither route may
// leave a rack standing more copies in its rows than it holds: both come
// through trimPlacements() in ./helpers.js.

import { Router } from 'express';
import { asyncHandler } from '../asyncHandler.js';

import { moveEnds, moveModule, ownRack, trimPlacements } from './helpers.js';

export function rackModuleRoutes(db) {
  const { RackModule } = db.models;
  const router = Router();

  // Move a module from this rack to another of the user's racks. If the
  // target rack already has the module, the quantities merge.
  // Body: { to_rack_id, quantity? } — quantity moves only some of the copies
  // this rack holds and leaves the rest behind, so two of the same module can
  // be split between racks; omitted, the whole holding moves.
  router.post('/:id/modules/:moduleId/move', asyncHandler(async (req, res) => {
    const ends = await moveEnds(db, req, res, Number(req.body?.to_rack_id));
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
      moveModule(db, ends.from, ends.to, moduleId, transaction, count)
    );
    const moved = count ?? source.quantity;
    res.json({ ok: true, moved, left: source.quantity - moved });
  }));

  // a time. Same rules as the single move, applied to a list — and the whole
  // list is checked before anything is written, so a mistyped id moves
  // nothing rather than half of them.
  // Body: { to_rack_id, module_ids: [...], quantities?: { <module_id>: n } }
  // A module with a quantity sends only that many copies and leaves the rest
  // in this rack; one without sends everything the rack holds of it.
  router.post('/:id/modules/move', asyncHandler(async (req, res) => {
    const ends = await moveEnds(db, req, res, Number(req.body?.to_rack_id));
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
        await moveModule(db, ends.from, ends.to, moduleId, transaction, count);
      }
    });
    res.json({ ok: true, moved: moduleIds.length, copies, to_rack_id: ends.to.id });
  }));

  // Set how many copies of a module this rack contains. Body: { quantity }.
  // Rack modules are the inventory the layout consumes, so shrinking below
  // the number already placed also removes the excess placements (highest
  // positions first) to keep the layout within the inventory.
  router.put('/:id/modules/:moduleId', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
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
      await trimPlacements(db, rack.id, mapping.module_id, quantity, transaction);
    });
    res.json({ ok: true, quantity });
  }));

  return router;
}
