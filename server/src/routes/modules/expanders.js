import { Router } from 'express';
import { Op } from 'sequelize';
import { refreshModuleLinks } from '../../services/moduleLinks.js';
import { requireOwnedModule, userModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function moduleExpanderRoutes(db) {
  const {
    ModuleExpander,
  } = db.models;
  const router = Router();

  // ---- expanders ----
  // Declare that another module is an expander of this one: two panels joined
  // by a ribbon cable that work as one instrument (Atlantix + Atlx, Quad
  // Operator + Algo, Bohm + Groove). Once declared, this module's routes and
  // normalizations may reach the expander's jacks, and a patch holding both
  // instances traces signal across the pair. Body: { expander_module_id }
  router.post('/:id/expanders', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const host = req.module;
    const expander = await userModule(db, req.user.id, req.body?.expander_module_id);
    if (!expander) {
      return res
        .status(400)
        .json({ error: 'expander_module_id must be a module in one of your racks' });
    }
    if (expander.id === host.id) {
      return res.status(400).json({ error: 'a module cannot expand itself' });
    }
    const existing = await ModuleExpander.findOne({
      where: {
        [Op.or]: [
          { host_module_id: host.id, expander_module_id: expander.id },
          { host_module_id: expander.id, expander_module_id: host.id },
        ],
      },
    });
    if (existing) {
      return res.status(409).json({ error: 'these two modules are already linked' });
    }
    const row = await ModuleExpander.create({
      host_module_id: host.id,
      expander_module_id: expander.id,
      description: String(req.body?.description || '').trim() || null,
    });
    // Paths the manual described across the two panels can be created now
    // that the link exists.
    await refreshModuleLinks(db, host);
    res.status(201).json({
      id: row.id,
      role: 'expander',
      module_id: expander.id,
      manufacturer: expander.manufacturer,
      name: expander.name,
      description: row.description,
    });
  }));

  router.delete('/:id/expanders/:expanderId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    // Either side of the pair may unlink it.
    const deleted = await ModuleExpander.destroy({
      where: {
        id: Number(req.params.expanderId) || 0,
        [Op.or]: [{ host_module_id: module.id }, { expander_module_id: module.id }],
      },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Expander link not found' });
    res.json({ ok: true });
  }));

  return router;
}
