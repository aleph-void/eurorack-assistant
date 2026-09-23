import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createBareDb } from './helpers.js';
import { migrate, rollback } from '../src/db/migrate.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');

// A database the migrations up to and including `last` have been applied to.
// (Rolling the real schema back and forward again is not an option: pg-mem
// keeps a dropped table's primary-key index name.)
async function migratedTo(last) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }');
  for (const name of fs.readdirSync(MIGRATIONS)) {
    if (/^\d+_.*\.js$/.test(name) && name <= `${last}.js`) {
      fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
    }
  }
  const db = createBareDb();
  try {
    await migrate(db, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return db;
}

// Migration 048 seeds each system's exits from the racks standing in it, one
// row per jack; 049 turns both lists into one row per module with its jacks
// under it. 049's down goes back to one row per jack.
describe('migrations 048 and 049 (system outputs; outputs are modules)', () => {
  it('seeds the systems, folds the jacks of a module under one row, and unfolds them again', async () => {
    const db = await migratedTo('047_outputs');
    const one = async (text, bind) => (await db.query(text, bind)).rows[0];
    const user = await one("INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id");
    const system = await one("INSERT INTO systems (user_id, name) VALUES ($1, 'studio') RETURNING id", [user.id]);
    const inSystem = await one("INSERT INTO racks (user_id, name, system_id) VALUES ($1, 'a', $2) RETURNING id", [user.id, system.id]);
    const alone = await one("INSERT INTO racks (user_id, name) VALUES ($1, 'b') RETURNING id", [user.id]);
    const outs = await one("INSERT INTO modules (manufacturer, name) VALUES ('Intellijel', 'Outs') RETURNING id");
    const left = await one("INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'L') RETURNING id", [outs.id]);
    const right = await one("INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'R') RETURNING id", [outs.id]);
    await db.query(
      `INSERT INTO rack_outputs (rack_id, module_id, component_id, position) VALUES
       ($1, $3, $4, 1), ($1, $3, $5, 2), ($2, $3, $4, 1)`,
      [inSystem.id, alone.id, outs.id, left.id, right.id]
    );

    await migrate(db);
    const rackRows = (await db.query('SELECT id, rack_id FROM rack_outputs ORDER BY rack_id')).rows;
    expect(rackRows.map((r) => r.rack_id)).toEqual([inSystem.id, alone.id]);
    const jacksOf = async (table, outputId) =>
      (await db.query(`SELECT component_id FROM ${table} WHERE output_id = $1 ORDER BY position`, [outputId])).rows.map((r) => r.component_id);
    expect(await jacksOf('rack_output_jacks', rackRows[0].id)).toEqual([left.id, right.id]);
    expect(await jacksOf('rack_output_jacks', rackRows[1].id)).toEqual([left.id]);
    const systemRows = (await db.query('SELECT id, system_id, rack_id, module_id FROM system_outputs')).rows;
    expect(systemRows).toEqual([expect.objectContaining({ system_id: system.id, rack_id: inSystem.id, module_id: outs.id })]);
    expect(await jacksOf('system_output_jacks', systemRows[0].id)).toEqual([left.id, right.id]);

    // A module with no jacks cannot go back to 047's shape, so it goes.
    const mixer = await one("INSERT INTO modules (manufacturer, name) VALUES ('Mutable', 'Shades') RETURNING id");
    await db.query('INSERT INTO rack_outputs (rack_id, module_id, position) VALUES ($1, $2, 3)', [alone.id, mixer.id]);
    await rollback(db, { to: '048_system_outputs' });
    const systemBack = (await db.query('SELECT component_id FROM system_outputs ORDER BY position')).rows;
    expect(systemBack.map((r) => r.component_id)).toEqual([left.id, right.id]);
    const back = (await db.query('SELECT rack_id, component_id FROM rack_outputs ORDER BY rack_id, position')).rows;
    expect(back).toEqual([
      { rack_id: inSystem.id, component_id: left.id },
      { rack_id: inSystem.id, component_id: right.id },
      { rack_id: alone.id, component_id: left.id },
    ]);
  });
});
