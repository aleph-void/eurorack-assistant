import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const db = createPool();
migrate(db)
  .then((ran) => {
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
    return db.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
