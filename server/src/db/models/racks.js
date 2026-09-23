// Racks, the systems they stand in, and the rows they are organized into.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineRacksModels(define) {
  // A user's racks; modules are mapped into racks, not directly onto users.
  // A collection of racks patched together as one instrument (migration
  // 028): the studio, or the live case plus the skiff that travels with it.
  const System = define(
    'System',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      // The size of the floor plan the racks are arranged on (migration
      // 029), in the units the rack coordinates use: HP across, U down.
      floor_width: { type: DataTypes.REAL, allowNull: false, defaultValue: 140 },
      floor_height: { type: DataTypes.REAL, allowNull: false, defaultValue: 9 },
    },
    { tableName: 'systems', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Rack = define(
    'Rack',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      // Which system this rack is part of, and where it stands on that
      // system's floor plan (migration 028). Coordinates are HP across and
      // rack-units down; position is the tie-breaking order.
      system_id: { type: DataTypes.INTEGER },
      system_x: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      system_y: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      system_position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'racks', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const RackModule = define(
    'RackModule',
    {
      rack_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    { tableName: 'rack_modules', createdAt: 'created_at', updatedAt: false }
  );

  const RackRow = define(
    'RackRow',
    {
      id,
      rack_id: { type: DataTypes.INTEGER, allowNull: false },
      unit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      hp: { type: DataTypes.REAL, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'rack_rows', createdAt: 'created_at', updatedAt: false }
  );

  const RackRowModule = define(
    'RackRowModule',
    {
      id,
      row_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'rack_row_modules', createdAt: 'created_at', updatedAt: false }
  );

  // A module of the rack that sound leaves the system at — an output
  // module, the mixer on the desk — recorded on the rack because whether a
  // module feeds the speakers is a fact about the studio, not the module
  // (migration 047). Which of its jacks are in use is optional: the jacks
  // under it (migration 048), none meaning the module as a whole.
  const outputJack = (name, tableName) =>
    define(
      name,
      {
        id,
        output_id: { type: DataTypes.INTEGER, allowNull: false },
        component_id: { type: DataTypes.INTEGER, allowNull: false },
        position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      },
      { tableName, timestamps: false }
    );

  const RackOutput = define(
    'RackOutput',
    {
      id,
      rack_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'rack_outputs', createdAt: 'created_at', updatedAt: false }
  );
  const RackOutputJack = outputJack('RackOutputJack', 'rack_output_jacks');

  // The same, for a whole system (migration 048): a studio of several cases
  // has one set of exits, and a patch of the system builds towards those.
  // `rack_id` says which case the marked module stands in, since the same
  // module may be racked in two of them.
  const SystemOutput = define(
    'SystemOutput',
    {
      id,
      system_id: { type: DataTypes.INTEGER, allowNull: false },
      rack_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'system_outputs', createdAt: 'created_at', updatedAt: false }
  );
  const SystemOutputJack = outputJack('SystemOutputJack', 'system_output_jacks');

  return {
    System,
    Rack,
    RackModule,
    RackRow,
    RackRowModule,
    RackOutput,
    RackOutputJack,
    SystemOutput,
    SystemOutputJack,
  };
}
