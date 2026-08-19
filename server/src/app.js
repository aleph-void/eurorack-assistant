import express from 'express';
import cookieParser from 'cookie-parser';
import { createLimiters } from './rateLimit.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { moduleRoutes } from './routes/modules/index.js';
import { rackRoutes } from './routes/racks.js';
import { manualRoutes } from './routes/manuals.js';
import { importRoutes } from './routes/imports.js';
import { questionRoutes } from './routes/questions.js';
import { configRoutes } from './routes/config.js';
import { llmRoutes } from './routes/llm.js';
import { usageRoutes } from './routes/usage.js';
import { jobRoutes } from './routes/jobs.js';
import { noteRoutes } from './routes/notes.js';
import { exportRoutes } from './routes/exports.js';
import { patchRoutes } from './routes/patches/index.js';
import { oauthRoutes } from './routes/oauth.js';
import { deviceRoutes } from './routes/devices.js';
import { scopeRoutes } from './routes/scope.js';
import { captureRoutes } from './routes/captures.js';
import { panelRoutes } from './routes/panels.js';
import { shareRoutes } from './routes/shares.js';

export function createApp(
  db,
  { manualsDir, exportsDir, capturesDir, panelsDir, videosDir, rateLimit, hub, bus = null, fetchImpl } = {}
) {
  const app = express();
  // nginx is the only hop in front of the server and it sets X-Forwarded-For.
  // Without this the rate limiters would see every request as coming from the
  // proxy's address and put all users in one bucket — one noisy client would
  // lock out everyone else.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '40mb' }));
  app.use(cookieParser());

  // Registered before the limiters so probes never consume a request budget.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const limiters = createLimiters(rateLimit);
  app.use('/api', limiters.api);
  app.use('/api/auth/login', limiters.credentials);
  app.use('/api/auth/password', limiters.credentials);

  app.use('/api/auth', authRoutes(db));
  app.use('/api/users', userRoutes(db));
  app.use('/api/modules', moduleRoutes(db, { manualsDir, panelsDir, videosDir, fetchImpl }));
  app.use('/api/racks', rackRoutes(db));
  app.use('/api/manuals', manualRoutes(db, { manualsDir }));
  app.use('/api/panels', panelRoutes(db, { panelsDir }));
  app.use('/api/imports', importRoutes(db));
  app.use('/api/questions', questionRoutes(db));
  app.use('/api/config', configRoutes(db));
  // Per-user LLM provider accounts: who each user's model runs bill to.
  app.use('/api/llm', llmRoutes(db, { fetchImpl }));
  app.use('/api/usage', usageRoutes(db));
  // The bus lets the route tell every connected user the queue is running
  // again; without one, resuming is simply not announced.
  app.use('/api/jobs', jobRoutes(db, { bus }));
  app.use('/api/notes', noteRoutes(db));
  app.use('/api/shares', shareRoutes(db));
  app.use('/api/exports', exportRoutes(db, { exportsDir }));
  app.use('/api/patches', patchRoutes(db));
  // Oscilloscope integration: /api/oauth is the device's half of the linking
  // flow (unauthenticated by necessity), everything else is the user's.
  app.use('/api/oauth', oauthRoutes(db));
  app.use('/api/devices', deviceRoutes(db, { hub }));
  app.use('/api/scope', scopeRoutes(db, { hub, capturesDir }));
  app.use('/api/captures', captureRoutes(db, { capturesDir }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
