import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBareDb, createTestDb } from './helpers.js';
import { migrate, rollback, status } from '../src/db/migrate.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  // The temp directory is outside the server package, so its .js files would
  // otherwise be read as CommonJS and reject `export`.
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A migration module, written as one would be written by hand.
function writeMigration(name, { up, down = 'await dropTable(\'tt\');', description = 'test' } = {}) {
  fs.writeFileSync(
    path.join(dir, name),
    `export const description = '${description}';
export async function up({ sql, addColumn }) { ${up} }
export async function down({ sql, dropColumn, dropTable }) { ${down} }
`
  );
}

const CREATE_TT = "await sql`CREATE TABLE tt (id INTEGER)`;";

// The ledger as a database that has been running since before this library
// holds it.
const LEGACY_LEDGER =
  'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT, applied_at TIMESTAMPTZ)';

describe('migrate', () => {
  it('applies each migration once and records its checksum', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: CREATE_TT });

    expect(await migrate(db, dir)).toEqual(['900_test']);
    expect(await migrate(db, dir)).toEqual([]);

    const { rows } = await db.query("SELECT checksum FROM schema_migrations WHERE name = '900_test'");
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    // The migration really ran.
    await db.query('INSERT INTO tt (id) VALUES (1)');
  });

  it('applies migrations in file name order', async () => {
    const db = createBareDb();
    writeMigration('902_c.js', { up: "await sql`CREATE TABLE cc (id INTEGER)`;" });
    writeMigration('900_a.js', { up: CREATE_TT });
    writeMigration('901_b.js', { up: "await addColumn('tt', 'extra', 'TEXT');" });

    expect(await migrate(db, dir)).toEqual(['900_a', '901_b', '902_c']);
  });

  it('refuses a migration that does not export a down', async () => {
    const db = createBareDb();
    fs.writeFileSync(path.join(dir, '900_test.js'), 'export async function up() {}\n');

    await expect(migrate(db, dir)).rejects.toThrow(/900_test does not export a down/);
  });

  it('fails loudly when an applied migration was edited afterwards', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: CREATE_TT });
    await migrate(db, dir);

    writeMigration('900_test.js', { up: "await sql`CREATE TABLE tt (id INTEGER, extra TEXT)`;" });
    await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('does not mind an edited down: filling one in later must stay possible', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: CREATE_TT, down: "throw new Error('not written yet');" });
    await migrate(db, dir);

    writeMigration('900_test.js', { up: CREATE_TT, down: "await dropTable('tt');" });
    expect(await migrate(db, dir)).toEqual([]);
    expect(await rollback(db, { dir })).toEqual(['900_test']);
  });

  it('adopts a checksum for rows recorded before checksum tracking', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: CREATE_TT });
    // A ledger from before the checksum column existed at all.
    await db.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)');
    await db.query("INSERT INTO schema_migrations (name) VALUES ('900_test')");

    expect(await migrate(db, dir)).toEqual([]); // treated as applied, not re-run
    const { rows } = await db.query("SELECT checksum FROM schema_migrations WHERE name = '900_test'");
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    // From here on, edits to the file are detected.
    writeMigration('900_test.js', { up: "await sql`CREATE TABLE tt (id INTEGER, extra TEXT)`;" });
    await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('adopts rows a database recorded when migrations were .sql files', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: CREATE_TT });
    // What the previous runner wrote: the file name, and the checksum of the
    // SQL file that no longer exists.
    await db.query(LEGACY_LEDGER);
    await db.query(
      "INSERT INTO schema_migrations (name, checksum) VALUES ('900_test.sql', 'checksum-of-the-old-sql-file')"
    );

    expect(await migrate(db, dir)).toEqual([]); // not re-run against a live database
    const { rows } = await db.query('SELECT name, checksum FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['900_test']);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not record a migration whose up threw', async () => {
    const db = createBareDb();
    writeMigration('900_test.js', { up: "await sql`CREATE TABLE tt (nonsense NOT A TYPE)`;" });

    await expect(migrate(db, dir)).rejects.toThrow();
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    expect(rows).toEqual([]);
  });
});

describe('rollback', () => {
  const three = async (db) => {
    writeMigration('900_a.js', { up: CREATE_TT, down: "await dropTable('tt');" });
    writeMigration('901_b.js', {
      up: "await addColumn('tt', 'extra', 'TEXT');",
      down: "await dropColumn('tt', 'extra');",
    });
    writeMigration('902_c.js', {
      up: "await sql`CREATE TABLE cc (id INTEGER)`;",
      down: "await dropTable('cc');",
    });
    await migrate(db, dir);
  };

  it('reverts the last migration and forgets it', async () => {
    const db = createBareDb();
    await three(db);

    expect(await rollback(db, { dir })).toEqual(['902_c']);
    const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['900_a', '901_b']);
    await expect(db.query('SELECT * FROM cc')).rejects.toThrow();

    // ...and applying again puts it back.
    expect(await migrate(db, dir)).toEqual(['902_c']);
  });

  it('reverts several, newest first', async () => {
    const db = createBareDb();
    await three(db);

    expect(await rollback(db, { dir, steps: 3 })).toEqual(['902_c', '901_b', '900_a']);
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    expect(rows).toEqual([]);
  });

  it('reverts everything applied after a named migration', async () => {
    const db = createBareDb();
    await three(db);

    expect(await rollback(db, { dir, to: '900_a' })).toEqual(['902_c', '901_b']);
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['900_a']);
  });

  it('refuses a target that is not an applied migration', async () => {
    const db = createBareDb();
    await three(db);

    await expect(rollback(db, { dir, to: '901_typo' })).rejects.toThrow(/not an applied migration/);
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    expect(rows).toHaveLength(3);
  });

  it('refuses to revert past a migration whose file is gone', async () => {
    const db = createBareDb();
    await three(db);
    fs.rmSync(path.join(dir, '902_c.js'));

    await expect(rollback(db, { dir })).rejects.toThrow(/902_c is applied .* has no file/);
  });

  it('reverts the whole real schema, leaving nothing behind', async () => {
    // createTestDb() applies server/migrations in full; every down in it has
    // to take back exactly what its up made.
    const db = await createTestDb();

    const reverted = await rollback(db, { steps: 999 });
    expect(reverted[0]).toBe('031_panel_trimmed');
    expect(reverted[reverted.length - 1]).toBe('001_init');

    const { rows } = await db.query(
      'SELECT DISTINCT table_name FROM information_schema.columns ORDER BY table_name'
    );
    expect(rows.map((r) => r.table_name)).toEqual(['schema_migrations']);
    const ledger = await db.query('SELECT name FROM schema_migrations');
    expect(ledger.rows).toEqual([]);
  });
});

describe('status', () => {
  it('reports what has run and what has not', async () => {
    const db = createBareDb();
    writeMigration('900_a.js', { up: CREATE_TT, description: 'first' });
    await migrate(db, dir);
    writeMigration('901_b.js', { up: "await sql`CREATE TABLE cc (id INTEGER)`;", description: 'second' });

    expect(await status(db, dir)).toEqual([
      { id: '900_a', description: 'first', applied: true, changed: false, missing: false },
      { id: '901_b', description: 'second', applied: false, changed: false, missing: false },
    ]);
  });

  it('flags a migration applied here but missing from the directory', async () => {
    const db = createBareDb();
    writeMigration('900_a.js', { up: CREATE_TT });
    await migrate(db, dir);
    fs.rmSync(path.join(dir, '900_a.js'));

    expect(await status(db, dir)).toEqual([
      { id: '900_a', description: '', applied: true, changed: false, missing: true },
    ]);
  });
});
