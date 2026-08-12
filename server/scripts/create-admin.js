// Creates the initial admin account and prints its credentials ONCE.
// The password is stored only as a bcrypt hash. Pass --reset to generate a
// new random password for an existing admin.

import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { ensureAdmin } from '../src/setupAdmin.js';

const reset = process.argv.includes('--reset');

const db = createDatabase();
try {
  await migrate(db);
  const result = await ensureAdmin(db, { reset });
  if (result.password) {
    console.log('');
    console.log('==============================================');
    console.log('  Admin account ' + (result.created ? 'created' : 'password reset'));
    console.log(`  Username: ${result.username}`);
    console.log(`  Password: ${result.password}`);
    console.log('==============================================');
    console.log('  Store these credentials now — the password');
    console.log('  is not saved anywhere else in cleartext.');
    console.log('  The admin must set a new password at the');
    console.log('  first login with this one.');
    console.log('==============================================');
    console.log('');
  } else {
    console.log(
      `Admin account '${result.username}' already exists. ` +
        'Run with --reset to generate a new password.'
    );
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.close();
}
