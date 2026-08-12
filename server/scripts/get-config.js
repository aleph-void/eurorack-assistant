// Print a raw app_config value, e.g.:
//   node scripts/get-config.js llm_provider
// Prints nothing (exit 0) when the key was never set — unlike the API's
// getConfig, defaults are NOT merged in, so setup.sh can tell "explicitly
// configured" apart from "falling back to the default".

import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const [key] = process.argv.slice(2);
if (!key) {
  console.error('usage: node scripts/get-config.js <key>');
  process.exit(1);
}

const db = createDatabase();
try {
  await migrate(db);
  const row = await db.models.AppConfig.findByPk(key);
  if (row) console.log(row.value);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
