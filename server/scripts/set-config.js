// Set an app_config value from the command line, e.g.:
//   node scripts/set-config.js llm_provider claude

import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { setConfig } from '../src/services/config.js';

const [key, value] = process.argv.slice(2);
if (!key || value === undefined) {
  console.error('usage: node scripts/set-config.js <key> <value>');
  process.exit(1);
}

const db = createPool();
try {
  await migrate(db);
  const config = await setConfig(db, { [key]: value });
  console.log(`config updated: ${key}=${config[key]}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
