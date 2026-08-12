import fs from 'node:fs';
import http from 'node:http';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { createWorker } from './jobs/worker.js';
import { createBus } from './events.js';
import { attachWebSocketServer } from './ws.js';

const PORT = Number(process.env.PORT || 3000);
const MANUALS_DIR = process.env.MANUALS_DIR || '/data/manuals';

async function main() {
  const db = createPool();
  await migrate(db);
  fs.mkdirSync(MANUALS_DIR, { recursive: true });

  const bus = createBus();
  const app = createApp(db, { manualsDir: MANUALS_DIR });
  const server = http.createServer(app);
  const ws = attachWebSocketServer(server, db, bus);

  const worker = createWorker(db, { manualsDir: MANUALS_DIR, bus });
  worker.start();

  server.listen(PORT, () => {
    console.log(`eurorack-web server listening on :${PORT}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      worker.stop();
      ws.close();
      server.close(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
