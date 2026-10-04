// Performances: a published video of someone playing, what they played it
// on, and what everyone else said about it (migration 055).
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function definePerformancesModels(define) {
  // Readable by every account, editable by its author alone. The video is a
  // YouTube id and the canonical URL rebuilt from it; the patch is a soft
  // choice of the author's with its name snapshotted beside it.
  const Performance = define(
    'Performance',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      url: { type: DataTypes.TEXT, allowNull: false },
      video_id: { type: DataTypes.TEXT, allowNull: false },
      public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      patch_id: { type: DataTypes.INTEGER },
      patch_name: { type: DataTypes.TEXT },
    },
    { tableName: 'performances', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // The modules the author lists as used, in their order.
  const PerformanceModule = define(
    'PerformanceModule',
    {
      performance_id: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'performance_modules', timestamps: false }
  );

  const PerformanceComment = define(
    'PerformanceComment',
    {
      id,
      performance_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'performance_comments', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  return { Performance, PerformanceModule, PerformanceComment };
}
