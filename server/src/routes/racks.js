import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findRackByName } from '../services/racks.js';
import { readableResource, removeShares } from '../services/sharing.js';
import { enqueueJob } from '../jobs/worker.js';
import { loadPanels } from '../services/panelImage.js';
import { asyncHandler } from './asyncHandler.js';

// A user's racks. Every route operates on the requesting user's racks only —
// racks (and their module lists) are never visible to other users.
export function rackRoutes(db) {
  const { Rack, RackModule, RackRow, RackRowModule, Module, User, Job } = db.models;
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

  return router;
}
