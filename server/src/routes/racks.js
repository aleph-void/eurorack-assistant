import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { findRackByName } from '../services/racks.js';
import { deleteModulesDeep } from '../services/moduleDeletion.js';
import { readableResource, removeShares } from '../services/sharing.js';
import { enqueueJob } from '../jobs/worker.js';

// A user's racks. Every route operates on the requesting user's racks only —
// racks (and their module lists) are never visible to other users.
export function rackRoutes(
  db,
  {
    manualsDir = process.env.MANUALS_DIR || '/data/manuals',
    panelsDir = process.env.PANELS_DIR || '/data/panels',
  } = {}
) {
  const { Rack, RackModule, Module, User, Job } = db.models;
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

  router.get('/', async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // One rack and what is in it: yours, or one somebody shared with you. This
  // is the whole of a shared rack — the module list, as it stands — and it is
  // read-only, every other route here being the owner's alone.
  router.get('/:id', async (req, res, next) => {
    try {
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
            summary: rm.Module.summary,
            quantity: rm.quantity,
          })),
      });
    } catch (e) {
      next(e);
    }
  });

  // Body: { name }
  router.post('/', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (await findRackByName(db, req.user.id, name)) {
        return res.status(409).json({ error: `you already have a rack named '${name}'` });
      }
      const rack = await Rack.create({ user_id: req.user.id, name });
      res.status(201).json(rackJson(rack, 0));
    } catch (e) {
      next(e);
    }
  });

  // Rename. Body: { name }
  router.put('/:id', async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // Deleting a rack removes its module mappings, then fully deletes every
  // module that is left in no rack at all — along with its components,
  // manuals, and *your* questions and notes about it (other users' stay).
  // Modules still mapped into another rack (yours or another user's) are
  // kept.
  router.delete('/:id', async (req, res, next) => {
    try {
      const rack = await ownRack(req.user.id, req.params.id);
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      const mappings = await RackModule.findAll({ where: { rack_id: rack.id } });
      await rack.destroy();
      await removeShares(db, 'rack', rack.id);
      const orphaned = [];
      for (const { module_id: moduleId } of mappings) {
        if ((await RackModule.count({ where: { module_id: moduleId } })) === 0) {
          orphaned.push(moduleId);
        }
      }
      await deleteModulesDeep(db, req.user.id, orphaned, { manualsDir, panelsDir });
      res.json({ ok: true, deleted_modules: orphaned.length });
    } catch (e) {
      next(e);
    }
  });

  // Queue a background export of everything about the rack's modules —
  // manual PDFs plus the user's notes and questions rendered to PDF — into
  // one zip. The client auto-downloads the zip when the job's 'completed'
  // event arrives over the WebSocket (the link also shows on the Jobs page).
  router.post('/:id/export', async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // Move a module from this rack to another of the user's racks. If the
  // target rack already has the module, the quantities merge.
  // Body: { to_rack_id }
  router.post('/:id/modules/:moduleId/move', async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  return router;
}
