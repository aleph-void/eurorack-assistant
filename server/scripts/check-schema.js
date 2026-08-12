// Verify the live database schema matches the models: probe each model with
// a query that selects every mapped column. Prints 'ok' when the schema is
// usable, or 'drift: <reason>' when a table or column is missing. setup.sh
// runs this after migrations — this app is pre-release and folds schema
// changes into the initial migration, so a database initialized from an older
// revision can be stale even though migrations report clean.

import { createDatabase } from '../src/db/index.js';

const db = createDatabase();
let status = 'ok';
try {
  for (const model of Object.values(db.models)) {
    try {
      await model.findOne();
    } catch (e) {
      status = `drift: ${model.name}: ${e.parent?.message || e.message}`;
      break;
    }
  }
} catch (e) {
  status = `drift: ${e.message}`;
  process.exitCode = 1;
} finally {
  await db.close();
}
console.log(status);
