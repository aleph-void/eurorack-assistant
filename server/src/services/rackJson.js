// Serializer shapes for racks: the rack record itself and its physical row
// layout. Both the /api/racks routes and the /api/systems routes hand racks
// back, and a rack must look the same on either.

import { loadPanels } from './panelImage.js';
import { rackFootprint } from './racks.js';

export const rackJson = (rack, moduleCount) => ({
  id: rack.id,
  name: rack.name,
  module_count: moduleCount,
  // Which system the rack belongs to, and where it stands on that system's
  // floor plan. Null system_id is a rack on its own.
  system_id: rack.system_id ?? null,
  system_x: rack.system_x ?? 0,
  system_y: rack.system_y ?? 0,
  system_position: rack.system_position ?? 0,
  created_at: rack.created_at,
  updated_at: rack.updated_at,
});

// The rack's rows with the module copies placed in them. `mappings` are the
// rack's rack_modules rows with their Module included; `panels` the front
// panel pictures, already loaded, so a page of racks costs one lookup rather
// than one per rack.
export async function layoutJson(db, rack, mappings, panels = new Map()) {
  const { RackRow, RackRowModule } = db.models;
  const rows = await RackRow.findAll({
    where: { rack_id: rack.id },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const placements = rows.length
    ? await RackRowModule.findAll({
        where: { row_id: rows.map((row) => row.id) },
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
      })
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

// One rack, whole: the record, its module inventory and its rows. Used by the
// rack detail route and by the system view, which draws every rack it holds.
export async function rackDetailJson(db, rack, { panels = null } = {}) {
  const { RackModule, Module } = db.models;
  const mappings = await RackModule.findAll({
    where: { rack_id: rack.id },
    include: Module,
    order: [
      [Module, 'manufacturer', 'ASC'],
      [Module, 'name', 'ASC'],
    ],
  });
  const loaded = panels ?? (await loadPanels(db, mappings.map((mapping) => mapping.module_id)));
  const rows = await layoutJson(db, rack, mappings, loaded);
  return {
    ...rackJson(rack, mappings.length),
    // How much floor the rack takes on a system plan. Sent with the rack so
    // the plan places boxes from the same geometry the server validates
    // placements with, rather than deriving its own from the rows.
    ...rackFootprint(rows),
    modules: mappings
      .filter((rm) => rm.Module)
      .map((rm) => ({
        id: rm.Module.id,
        manufacturer: rm.Module.manufacturer,
        name: rm.Module.name,
        hp: rm.Module.hp,
        panel: loaded.get(rm.Module.id) ?? null,
        summary: rm.Module.summary,
        quantity: rm.quantity,
      })),
    rows,
  };
}
