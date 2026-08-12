import { createDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const db = createDatabase();
migrate(db)
  .then((ran) => {
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
    return db.close();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
