// What the backup script reported, run by run.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.
//
// A backup run belongs to nobody — it is the deployment's, not a user's —
// and joins nothing in the association graph (migration 053), which is why it
// is a domain of its own rather than a table filed under jobs.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineBackupsModels(define) {
  // One run of backup-to-s3.sh, as it reported itself on ending. Written by
  // services/backups.js (through scripts/report-backup.js), read by
  // routes/backups.js.
  const BackupRun = define(
    'BackupRun',
    {
      id,
      status: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      size_bytes: { type: DataTypes.BIGINT },
      message: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      host: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      started_at: { type: DataTypes.DATE },
      finished_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      alerted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'backup_runs', timestamps: false }
  );

  return { BackupRun };
}
