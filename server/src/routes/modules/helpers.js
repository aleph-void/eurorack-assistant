import { Op } from 'sequelize';

// Helpers shared by the /api/modules sub-routers. Each takes db explicitly so
// the sub-routers stay plain factory functions over it.

// The modules whose components this module's signal paths may reference:
// itself, plus any expander declared on it (and any host that declares it
// as an expander). An expander is wired to its host by a ribbon cable, so
// the pair's internal signal paths cross between the two panels.
export async function linkedModuleIds(db, moduleId) {
  const { ModuleExpander } = db.models;
  const rows = await ModuleExpander.findAll({
    where: { [Op.or]: [{ host_module_id: moduleId }, { expander_module_id: moduleId }] },
  });
  const ids = new Set([moduleId]);
  for (const row of rows) {
    ids.add(row.host_module_id);
    ids.add(row.expander_module_id);
  }
  return [...ids];
}

// Find a component on the module or on one of its linked panels.
export async function linkedComponent(db, moduleId, componentId) {
  const { ModuleComponent } = db.models;
  if (!Number(componentId)) return null;
  return ModuleComponent.findOne({
    where: { id: Number(componentId), module_id: await linkedModuleIds(db, moduleId) },
  });
}

// The condition on a route or normalization: the control position that path
// depends on. Body fields condition_component_id + condition_value (both or
// neither), plus a free-text alt_group tying alternatives together.
export async function readCondition(db, module, body) {
  const rawId = body?.condition_component_id;
  const rawValue = String(body?.condition_value ?? '').trim();
  const altGroup = String(body?.alt_group ?? '').trim() || null;
  if (rawId === undefined || rawId === null || rawId === '') {
    if (rawValue) {
      return { error: 'condition_value needs a condition_component_id' };
    }
    return { fields: { condition_component_id: null, condition_value: null, alt_group: altGroup } };
  }
  const control = await linkedComponent(db, module.id, rawId);
  if (!control) {
    return { error: 'condition_component_id must be a component of this module' };
  }
  if (control.type.endsWith('_jack')) {
    return { error: 'a condition names a control (a switch, knob or toggle), not a jack' };
  }
  if (!rawValue) return { error: 'condition_value is required with condition_component_id' };
  return {
    fields: { condition_component_id: control.id, condition_value: rawValue, alt_group: altGroup },
  };
}

// The user's rack mappings for a module (across all their racks), or null
// if it isn't in any of them. Returns the module plus its per-rack
// placements and the total quantity.
export async function userModule(db, userId, moduleId) {
  const { Rack, RackModule, Module } = db.models;
  const mappings = await RackModule.findAll({
    where: { module_id: Number(moduleId) },
    include: [{ model: Rack, where: { user_id: userId } }, Module],
    order: [[Rack, 'name', 'ASC']],
  });
  if (mappings.length === 0 || !mappings[0].Module) return null;
  return {
    ...mappings[0].Module.get({ plain: true }),
    quantity: mappings.reduce((sum, rm) => sum + rm.quantity, 0),
    racks: mappings.map((rm) => ({
      id: rm.Rack.id,
      name: rm.Rack.name,
      quantity: rm.quantity,
    })),
  };
}

// Route middleware: load the module under req.params.id if the requesting
// user has it racked, 404 otherwise. Every /:id route that operates on a
// module goes through this, so "forgot the ownership check" cannot happen.
export function requireOwnedModule(db) {
  return (req, res, next) => {
    userModule(db, req.user.id, req.params.id)
      .then((module) => {
        if (!module) return res.status(404).json({ error: 'Module not found' });
        req.module = module;
        next();
      })
      .catch(next);
  };
}
