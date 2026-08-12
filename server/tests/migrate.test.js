import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/db/migrate.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrate', () => {
  it('applies each migration once and records its checksum', async () => {
    const db = await createTestDb();
    fs.writeFileSync(path.join(dir, '900_test.sql'), 'CREATE TABLE tt (id INTEGER);');

    expect(await migrate(db, dir)).toEqual(['900_test.sql']);
    expect(await migrate(db, dir)).toEqual([]);

    const { rows } = await db.query(
      "SELECT checksum FROM schema_migrations WHERE name = '900_test.sql'"
    );
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails loudly when an applied migration file was edited afterwards', async () => {
    const db = await createTestDb();
    const file = path.join(dir, '900_test.sql');
    fs.writeFileSync(file, 'CREATE TABLE tt (id INTEGER);');
    await migrate(db, dir);

    fs.writeFileSync(file, 'CREATE TABLE tt (id INTEGER, extra TEXT);');
    await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('adopts a checksum for rows recorded before checksum tracking', async () => {
    const db = await createTestDb();
    const file = path.join(dir, '900_test.sql');
    fs.writeFileSync(file, 'CREATE TABLE tt (id INTEGER);');
    // Simulate a legacy schema_migrations row without a checksum.
    await db.query("INSERT INTO schema_migrations (name) VALUES ('900_test.sql')");

    expect(await migrate(db, dir)).toEqual([]); // treated as applied, not re-run
    const { rows } = await db.query(
      "SELECT checksum FROM schema_migrations WHERE name = '900_test.sql'"
    );
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    // From here on, edits to the file are detected.
    fs.writeFileSync(file, 'CREATE TABLE tt (id INTEGER, extra TEXT);');
    await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
  });
});
