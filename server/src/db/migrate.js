// The migration runner.
//
// A migration is a module in server/migrations/ named <number>_<slug>.js that
// exports up() and down() (and, optionally, a one-line `description`). Both
// are called with the context built in migrationContext.js — a `sql` template
// plus the schema verbs — and both run inside a transaction, so a migration
// that throws leaves the database exactly as it found it (real postgres does
// DDL transactionally; pg-mem, which the tests use, does not).
//
// What has been applied is recorded in schema_migrations, keyed by the file
// name without its extension ('016_module_panels'). The row also carries a
// checksum of the migration's up() SOURCE: editing a migration that has
// already run somewhere is the one mistake this scheme cannot absorb, so it is
// caught loudly at startup rather than by a column that quietly never
// appeared. A down() may be edited freely — it is not part of the checksum,
// because filling one in later must not invalidate the databases the up()
// already ran on.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QueryTypes } from 'sequelize';
import { createMigrationContext } from './migrationContext.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const checksumOf = (fn) => crypto.createHash('sha256').update(String(fn)).digest('hex');

// Reads the migrations directory and imports every migration in it, in file
// name order (the numeric prefix is zero-padded, so that is apply order).
export async function loadMigrations(migrationsDir = DEFAULT_DIR) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
    .sort();

  const migrations = [];
  for (const file of files) {
    const id = file.replace(/\.js$/, '');
    const url = pathToFileURL(path.join(migrationsDir, file));
    // ESM caches modules by URL, and a migration edited between two loads in
    // one process (which is what the tests check for) would come back from
    // that cache with its old up() — the exact case the checksum exists to
    // catch. Keying the import on the file's mtime reads the file as it is.
    url.search = `mtime=${fs.statSync(url).mtimeMs}`;
    const module = await import(url.href);
    for (const hook of ['up', 'down']) {
      if (typeof module[hook] !== 'function') {
        throw new Error(`Migration ${id} does not export a ${hook}() function`);
      }
    }
    migrations.push({
      id,
      file,
      description: module.description ?? '',
      up: module.up,
      down: module.down,
      checksum: checksumOf(module.up),
    });
  }
  return migrations;
}

async function ensureLedger(sequelize) {
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
}

// The applied set, as id -> checksum, after reconciling the two shapes of row
// older databases can hold:
//   '016_module_panels.sql'  — recorded when migrations were SQL files. The
//                              name loses its extension and the row adopts the
//                              current checksum: the file was rewritten in the
//                              conversion, and its up() still does what it did.
//   checksum NULL            — recorded before checksums were tracked; adopts
//                              the current one, so later edits are caught.
async function readLedger(sequelize, migrations) {
  const rows = await sequelize.query('SELECT name, checksum FROM schema_migrations', {
    type: QueryTypes.SELECT,
  });
  const known = new Map(migrations.map((m) => [m.id, m]));
  const applied = new Map();

  for (const row of rows) {
    const id = row.name.replace(/\.sql$/, '');
    const migration = known.get(id);
    if (row.name !== id && migration) {
      await sequelize.query('UPDATE schema_migrations SET name = $1, checksum = $2 WHERE name = $3', {
        bind: [id, migration.checksum, row.name],
      });
      applied.set(id, migration.checksum);
      continue;
    }
    if (row.checksum == null && migration) {
      await sequelize.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', {
        bind: [migration.checksum, row.name],
      });
      applied.set(id, migration.checksum);
      continue;
    }
    applied.set(id, row.checksum);
  }
  return applied;
}

function assertUnchanged(migration, recorded) {
  if (recorded == null || recorded === migration.checksum) return;
  throw new Error(
    `Migration ${migration.id} changed after it was applied to this database. ` +
      'This pre-release app folds schema changes into the initial migration; ' +
      'recreate the database (docker compose down -v && ./setup.sh) to pick them up.'
  );
}

// Runs one direction of one migration, and its ledger row, in a transaction.
async function run(db, migration, direction) {
  const { sequelize } = db;
  await sequelize.transaction(async (transaction) => {
    await migration[direction](createMigrationContext(sequelize, transaction));
    if (direction === 'up') {
      await sequelize.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', {
        bind: [migration.id, migration.checksum],
        transaction,
      });
    } else {
      await sequelize.query('DELETE FROM schema_migrations WHERE name = $1', {
        bind: [migration.id],
        transaction,
      });
    }
  });
}

// Applies every migration that has not run yet, oldest first. Returns the ids
// of the ones it ran.
export async function migrate(db, migrationsDir = DEFAULT_DIR) {
  const migrations = await loadMigrations(migrationsDir);
  await ensureLedger(db.sequelize);
  const applied = await readLedger(db.sequelize, migrations);

  const ran = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      assertUnchanged(migration, applied.get(migration.id));
      continue;
    }
    await run(db, migration, 'up');
    ran.push(migration.id);
  }
  return ran;
}

// Reverts applied migrations, newest first: the last `steps` of them, or
// everything applied after `to` (that migration itself stays). Returns the ids
// it reverted, in the order it reverted them.
export async function rollback(db, { dir = DEFAULT_DIR, steps = 1, to = null } = {}) {
  const migrations = await loadMigrations(dir);
  await ensureLedger(db.sequelize);
  const applied = await readLedger(db.sequelize, migrations);

  const known = new Set(migrations.map((m) => m.id));
  const orphan = [...applied.keys()].find((id) => !known.has(id));
  if (orphan) {
    throw new Error(`Migration ${orphan} is applied to this database but has no file to revert it`);
  }

  // A mistyped target would otherwise be read as "everything is after this",
  // which is the one answer nobody means by it.
  if (to != null && !applied.has(String(to))) {
    throw new Error(`Cannot roll back to ${to}: it is not an applied migration`);
  }

  const appliedMigrations = migrations.filter((m) => applied.has(m.id));
  const target =
    to == null
      ? appliedMigrations.slice(Math.max(0, appliedMigrations.length - steps))
      : appliedMigrations.filter((m) => m.id > String(to));

  const reverted = [];
  for (const migration of target.reverse()) {
    await run(db, migration, 'down');
    reverted.push(migration.id);
  }
  return reverted;
}

// What has run and what has not, in apply order, for the CLI.
export async function status(db, migrationsDir = DEFAULT_DIR) {
  const migrations = await loadMigrations(migrationsDir);
  await ensureLedger(db.sequelize);
  const applied = await readLedger(db.sequelize, migrations);

  const known = new Set(migrations.map((m) => m.id));
  return [
    ...migrations.map((m) => ({
      id: m.id,
      description: m.description,
      applied: applied.has(m.id),
      changed: applied.has(m.id) && applied.get(m.id) != null && applied.get(m.id) !== m.checksum,
      missing: false,
    })),
    // Applied on this database but no longer in the directory — a checkout of
    // an older revision, or a migration somebody deleted.
    ...[...applied.keys()]
      .filter((id) => !known.has(id))
      .sort()
      .map((id) => ({ id, description: '', applied: true, changed: false, missing: true })),
  ];
}
