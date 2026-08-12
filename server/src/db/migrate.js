import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryTypes } from 'sequelize';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function migrate(db, migrationsDir = DEFAULT_DIR) {
  const { sequelize } = db;
  try {
    await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  } catch {
    // pg-mem (tests) errors when CREATE TABLE IF NOT EXISTS hits an existing
    // table; real PostgreSQL never does. If the table is genuinely missing,
    // the SELECT below fails loudly.
  }
  // Databases created before checksum tracking lack the column.
  try {
    await sequelize.query('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  } catch {
    /* column already exists */
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Map(
    (
      await sequelize.query('SELECT name, checksum FROM schema_migrations', {
        type: QueryTypes.SELECT,
      })
    ).map((r) => [r.name, r.checksum])
  );

  const ran = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      const recorded = applied.get(file);
      if (recorded == null) {
        // Row from before checksum tracking: adopt the current checksum so
        // future edits to the file are detected.
        await sequelize.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', {
          bind: [checksum, file],
        });
      } else if (recorded !== checksum) {
        throw new Error(
          `Migration ${file} changed after it was applied to this database. ` +
            'This pre-release app folds schema changes into the initial migration; ' +
            'recreate the database (docker compose down -v && ./setup.sh) to pick them up.'
        );
      }
      continue;
    }
    await sequelize.query(sql);
    await sequelize.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', {
      bind: [file, checksum],
    });
    ran.push(file);
  }
  return ran;
}
