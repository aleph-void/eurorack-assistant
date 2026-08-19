import fs from 'node:fs';
import http from 'node:http';
import { createDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { createWorker } from './jobs/worker.js';
import { createBus } from './events.js';
import { attachWebSocketServer } from './ws.js';
import { createDeviceHub } from './deviceHub.js';
import { pruneDeviceAuth } from './services/deviceAuth.js';
import { resolveLlmDataDir } from './services/llmAccounts.js';
import { sandboxConfig, prepareDirForSandbox } from './services/sandbox.js';

const PORT = Number(process.env.PORT || 3000);
const MANUALS_DIR = process.env.MANUALS_DIR || '/data/manuals';
const EXPORTS_DIR = process.env.EXPORTS_DIR || '/data/exports';
const CAPTURES_DIR = process.env.CAPTURES_DIR || '/data/captures';
const PANELS_DIR = process.env.PANELS_DIR || '/data/panels';
const VIDEOS_DIR = process.env.VIDEOS_DIR || '/data/videos';
// Lapsed device codes and long-revoked tokens are swept hourly.
const DEVICE_AUTH_PRUNE_MS = 60 * 60 * 1000;

async function main() {
  const db = createDatabase();
  await migrate(db);
  fs.mkdirSync(MANUALS_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  fs.mkdirSync(PANELS_DIR, { recursive: true });
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  // When the agent sandbox is enabled, the CLI runs as a separate uid that has
  // to traverse the LLM data root to reach its own credential dir. A volume
  // created before this feature existed is still node-only 0700 (Docker only
  // stamps image ownership onto a fresh volume), so open the root to the shared
  // group here — on every start, so an upgrade fixes itself. No-op otherwise.
  const sandbox = sandboxConfig();
  if (sandbox) {
    const llmDir = resolveLlmDataDir();
    fs.mkdirSync(llmDir, { recursive: true });
    prepareDirForSandbox(llmDir, sandbox);
  }

  const bus = createBus();
  // Connected oscilloscopes. The hub is shared by the HTTP routes (which ask
  // devices for captures) and the WebSocket server (which owns the sockets).
  const hub = createDeviceHub({ bus });
  const app = createApp(db, {
    manualsDir: MANUALS_DIR,
    exportsDir: EXPORTS_DIR,
    capturesDir: CAPTURES_DIR,
    panelsDir: PANELS_DIR,
    videosDir: VIDEOS_DIR,
    hub,
    bus,
  });
  const server = http.createServer(app);
  const ws = attachWebSocketServer(server, db, bus, { hub });

  const worker = createWorker(db, {
    manualsDir: MANUALS_DIR,
    exportsDir: EXPORTS_DIR,
    capturesDir: CAPTURES_DIR,
    panelsDir: PANELS_DIR,
    videosDir: VIDEOS_DIR,
    bus,
  });
  worker.start();

  const prune = setInterval(() => {
    pruneDeviceAuth(db).catch((e) => console.error('device auth prune failed:', e.message));
  }, DEVICE_AUTH_PRUNE_MS);
  prune.unref();

  server.listen(PORT, () => {
    console.log(`eurorack-assistant server listening on :${PORT}`);
  });

  // Shutting down has to wait for the worker: it hands its in-flight jobs
  // back to the queue, and exiting before that leaves them stranded in
  // 'running' until their lease goes stale. Docker gives us 10s by default,
  // which is plenty — the jobs are released, not waited on.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(prune);
      hub.closeAll();
      ws.close();
      server.close();
      try {
        await worker.stop();
      } catch (e) {
        console.error('worker shutdown failed:', e.message);
      }
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
