// A composition: its storyboard, and what performs it (migration 046).
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineCompositionsModels(define) {
  // A piece of music, storyboarded. Says nothing about hardware itself: it
  // is written before the patch exists and survives the case being rebuilt.
  const Composition = define(
    'Composition',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      tempo_bpm: { type: DataTypes.REAL },
    },
    { tableName: 'compositions', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // One frame of the storyboard, in playing order: the columns of the grid.
  const CompositionScene = define(
    'CompositionScene',
    {
      id,
      composition_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      duration_seconds: { type: DataTypes.REAL },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'composition_scenes', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // One part the piece is made of: the rows of the grid.
  const CompositionElement = define(
    'CompositionElement',
    {
      id,
      composition_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'voice' },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'composition_elements', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // What one element does in one scene. No row: not playing then.
  const CompositionSceneElement = define(
    'CompositionSceneElement',
    {
      id,
      scene_id: { type: DataTypes.INTEGER, allowNull: false },
      element_id: { type: DataTypes.INTEGER, allowNull: false },
      action: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'hold' },
      note: { type: DataTypes.TEXT },
    },
    {
      tableName: 'composition_scene_elements',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  // A composition performed on a patch: one row per pair, with its notes.
  const CompositionPatch = define(
    'CompositionPatch',
    {
      id,
      composition_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      notes: { type: DataTypes.TEXT },
    },
    { tableName: 'composition_patches', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // What realises one element in one patch. The four target columns are
  // soft references into the patch's own tables (the CHECKs in migration 046
  // hold them to one target); target_label is what it was called when it
  // was chosen, which is what the row still says after the target has gone.
  const CompositionMapping = define(
    'CompositionMapping',
    {
      id,
      composition_patch_id: { type: DataTypes.INTEGER, allowNull: false },
      element_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_module_id: { type: DataTypes.INTEGER },
      component_id: { type: DataTypes.INTEGER },
      group_id: { type: DataTypes.INTEGER },
      cable_id: { type: DataTypes.INTEGER },
      target_label: { type: DataTypes.TEXT, allowNull: false },
      note: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'composition_mappings', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  return {
    Composition,
    CompositionScene,
    CompositionElement,
    CompositionSceneElement,
    CompositionPatch,
    CompositionMapping,
  };
}
