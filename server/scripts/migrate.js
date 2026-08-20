// Applies, reverts and reports on the migrations in server/migrations/.
//
//   node scripts/migrate.js               apply everything pending (the default;
//                                         setup.sh and the server both do this)
//   node scripts/migrate.js status        what has run and what has not
//   node scripts/migrate.js down          revert the last migration
//   node scripts/migrate.js down 3        revert the last three
//   node scripts/migrate.js down --to 020_indexes
//                                         revert everything applied after that
//                                         one (it stays applied)

import { createDatabase } from '../src/db/index.js';
import { migrate, rollback, status } from '../src/db/migrate.js';

const [command = 'up', ...args] = process.argv.slice(2);

async function run(db) {
  if (command === 'up') {
    const ran = await migrate(db);
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
    return;
  }

  if (command === 'status') {
    const rows = await status(db);
    for (const row of rows) {
      const mark = row.missing ? '?' : row.applied ? '✔' : ' ';
      const note = row.missing
        ? '  (applied, but no file in this checkout)'
        : row.changed
          ? '  (CHANGED since it was applied)'
          : row.description
            ? `  ${row.description}`
            : '';
      console.log(`[${mark}] ${row.id}${note}`);
    }
    console.log(`${rows.filter((r) => !r.applied).length} pending`);
    return;
  }

  if (command === 'down') {
    const to = args[0] === '--to' ? args[1] : null;
    const steps = to ? 0 : Number(args[0] ?? 1);
    if (!to && (!Number.isInteger(steps) || steps < 1)) {
      throw new Error(`Not a number of migrations to revert: ${args[0]}`);
    }
    const reverted = await rollback(db, to ? { to } : { steps });
    console.log(reverted.length ? `Reverted migrations: ${reverted.join(', ')}` : 'Nothing to revert');
    return;
  }

  throw new Error(`Unknown command: ${command} (expected up, down or status)`);
}

const db = createDatabase();
try {
  await run(db);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.close();
}
