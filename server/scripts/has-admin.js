// Print 'yes' when an admin account exists, 'no' otherwise. Used by setup.sh
// to skip admin creation on re-runs.

import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const db = createDatabase();
try {
  await migrate(db);
  const admin = await db.models.User.findOne({ where: { is_admin: true } });
  console.log(admin ? 'yes' : 'no');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
