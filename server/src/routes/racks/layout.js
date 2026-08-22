// The physical layout of a rack: which module stands where in which row.
//
// Saved by REPLACEMENT — every row of the rack is deleted and the ones sent
// are written — so the rack row is locked first and rack_rows carries a
// unique (rack_id, position): two of these running at once would each delete
// the rows it can see and then insert its own, and the rack would end up
// holding both sets.

import { Router } from 'express';
import { layoutJson } from '../../services/rackJson.js';
import { loadPanels } from '../../services/panelJson.js';

import { ownRack } from './helpers.js';

export function rackLayoutRoutes(db) {
  const { Rack, RackModule, RackRow, RackRowModule, Module } = db.models;
  const router = Router();

  // Replace the physical layout of a rack. Rack modules remain the inventory;
  // every placement here consumes one copy from that inventory.
  // Body: { rows: [{ unit: 1|3, hp, modules: [{ module_id }] }] }
  router.put('/:id/layout', async (req, res, next) => {
    try {
      const rack = await ownRack(db, req.user.id, req.params.id);
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
        // Take the rack itself first, so two layout saves for the same rack
        // cannot interleave. Each one deletes the rows it can see and then
        // inserts its own: overlapping, both deletes run against the layout
        // as it stood BEFORE the other inserted (READ COMMITTED gives each
        // statement its own snapshot), and the rack ends up holding both
        // sets — the duplicated rows an organizer saving faster than it
        // answers used to leave behind.
        await Rack.findOne({ where: { id: rack.id }, transaction, lock: transaction.LOCK.UPDATE });
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

  return router;
}
