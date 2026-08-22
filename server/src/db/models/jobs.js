// The work queue. Everything slow in this app is a row in it.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineJobsModels(define) {
  const Job = define(
    'Job',
    {
      id,
      type: { type: DataTypes.TEXT, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      module_id: { type: DataTypes.INTEGER },
      question_id: { type: DataTypes.INTEGER },
      payload: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: DataTypes.TEXT },
      // Lease held by the worker that claimed the job: heartbeat_at is
      // refreshed while it runs, so a job orphaned by a killed process can be
      // recognised and requeued (see reclaimStaleJobs in jobs/worker.js).
      started_at: { type: DataTypes.DATE },
      heartbeat_at: { type: DataTypes.DATE },
      worker_id: { type: DataTypes.TEXT },
    },
    { tableName: 'jobs', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  return { Job };
}
