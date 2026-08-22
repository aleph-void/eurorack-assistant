// A patch: its snapshot of the studio, its cables and its settings.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function definePatchesModels(define) {
  // A user's patch: cables + settings against a snapshot of a rack. rack_id
  // and the module/component ids on the snapshot tables are soft references
  // (no FK): the patch keeps rendering from its denormalized name columns
  // after modules move racks, get re-analyzed or get deleted.
  const Patch = define(
    'Patch',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT, allowNull: false },
      // Set instead of rack_id when the patch was built from a whole system
      // (migration 028), and soft like it: the patch outlives the system.
      system_id: { type: DataTypes.INTEGER },
      system_name: { type: DataTypes.TEXT },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'patches', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // One row per module instance in the rack at patch creation (quantity 2 →
  // instance 1 and instance 2).
  const PatchModule = define(
    'PatchModule',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER },
      manufacturer: { type: DataTypes.TEXT, allowNull: false },
      module_name: { type: DataTypes.TEXT, allowNull: false },
      instance: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // Which rack this copy was snapshotted from (migration 028), so a
      // system patch spanning several racks can group its instances and
      // match each to the right rack's physical rows. Soft, like module_id.
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT },
      // What this instance does in this patch ("snare voice"), and which
      // named bus/layer it belongs to (soft reference into patch_groups).
      label: { type: DataTypes.TEXT },
      group_id: { type: DataTypes.INTEGER },
      // Off-rack gear (a DAW, a MIDI interface, the PA) rather than a module.
      // Both external gear and modules the rack does not hold declare their
      // connection points in patch_module_ports.
      external: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'patch_modules', createdAt: 'created_at', updatedAt: false }
  );

  // The physical arrangement the patch was built from (migration 030): the
  // rows of every rack it snapshotted, copied INTO the patch so the diagram
  // keeps drawing the studio as it stood, however the racks are reorganised
  // afterwards. Soft references, like the rest of a patch snapshot.
  const PatchRackRow = define(
    'PatchRackRow',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT },
      rack_position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Where the rack stood on the system's floor plan when the patch was
      // made: x in HP, y in rack units (migration 034).
      rack_x: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      rack_y: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      unit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      hp: { type: DataTypes.REAL, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_rack_rows', createdAt: 'created_at', updatedAt: false }
  );

  // One module standing in one of those rows, in the order it stands.
  const PatchRackRowModule = define(
    'PatchRackRowModule',
    {
      id,
      row_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_rack_row_modules', createdAt: 'created_at', updatedAt: false }
  );

  // A named bus or layer within a patch ("Rhythm", "Granular bus").
  const PatchGroup = define(
    'PatchGroup',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_groups', createdAt: 'created_at', updatedAt: false }
  );

  // A connection point declared inside the patch, for an instance with no
  // analyzed component list behind it: external gear, or a module the rack
  // does not hold. Cables address these exactly like components — the
  // patch_module at each end says which of the two namespaces the id is in.
  const PatchModulePort = define(
    'PatchModulePort',
    {
      id,
      patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'input_jack' },
      port_kind: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_module_ports', createdAt: 'created_at', updatedAt: false }
  );

  // Two instances wired together without patch cables: kind 'expander' (host
  // + expander panel, one instrument) or 'bridge' (a pair like Omnitone
  // 7Path carrying signals between two points over one non-patch link).
  const PatchModuleLink = define(
    'PatchModuleLink',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      a_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      b_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'expander' },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'patch_module_links', createdAt: 'created_at', updatedAt: false }
  );

  // Which jack on side A of a bridge carries the same signal as which jack
  // on side B.
  const PatchModuleLinkJack = define(
    'PatchModuleLinkJack',
    {
      id,
      link_id: { type: DataTypes.INTEGER, allowNull: false },
      a_component_id: { type: DataTypes.INTEGER },
      a_component_name: { type: DataTypes.TEXT, allowNull: false },
      b_component_id: { type: DataTypes.INTEGER },
      b_component_name: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'patch_module_link_jacks', createdAt: 'created_at', updatedAt: false }
  );

  const PatchCable = define(
    'PatchCable',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      from_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      from_component_id: { type: DataTypes.INTEGER },
      from_component_name: { type: DataTypes.TEXT, allowNull: false },
      to_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      to_component_id: { type: DataTypes.INTEGER },
      to_component_name: { type: DataTypes.TEXT, allowNull: false },
      note: { type: DataTypes.TEXT },
      // Provisional ("add the distortion layer later"), one of several
      // alternatives (same alt_group), or physically stacked onto the source
      // jack with a stackcable / passive mult.
      optional: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      stacked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      alt_group: { type: DataTypes.TEXT },
    },
    { tableName: 'patch_cables', createdAt: 'created_at', updatedAt: false }
  );

  const PatchSetting = define(
    'PatchSetting',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      component_id: { type: DataTypes.INTEGER },
      // Null on a setting of a module-wide menu parameter, which sits on no
      // component at all.
      component_name: { type: DataTypes.TEXT },
      // Soft reference to a module_parameters row, with its name snapshotted
      // beside it: one component may carry a dozen of these (an output jack's
      // division, wave and level) where a knob carries exactly one value.
      parameter_id: { type: DataTypes.INTEGER },
      parameter_name: { type: DataTypes.TEXT },
      value: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'patch_settings', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  return { Patch, PatchModule, PatchRackRow, PatchRackRowModule, PatchGroup, PatchModulePort, PatchModuleLink, PatchModuleLinkJack, PatchCable, PatchSetting };
}
