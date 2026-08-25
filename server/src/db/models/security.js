// What the browser refused, and told us about.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.
//
// A CSP report belongs to nobody — no user_id, no association graph to join
// it into (see migration 040) — which is why it is a domain of its own rather
// than a table filed under accounts.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineSecurityModels(define) {
  // One distinct Content-Security-Policy violation, with the number of times
  // it has been reported. Written by services/cspReports.js, read by
  // routes/cspReports.js.
  const CspReport = define(
    'CspReport',
    {
      id,
      fingerprint: { type: DataTypes.TEXT, allowNull: false, unique: true },
      disposition: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      directive: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      blocked_uri: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      document_uri: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      referrer: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      source_file: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      line_number: { type: DataTypes.INTEGER },
      column_number: { type: DataTypes.INTEGER },
      script_sample: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      original_policy: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      user_agent: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      report_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      first_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: 'csp_reports', timestamps: false }
  );

  return { CspReport };
}
