import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryTypes } from 'sequelize';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function migrate(db, migrationsDir = DEFAULT_DIR) {
  const { sequelize } = db;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (
      await sequelize.query('SELECT name FROM schema_migrations', { type: QueryTypes.SELECT })
    ).map((r) => r.name)
  );

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await sequelize.query(sql);
    await sequelize.query('INSERT INTO schema_migrations (name) VALUES ($1)', { bind: [file] });
    ran.push(file);
  }
  return ran;
}
