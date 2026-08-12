import express from 'express';
import cookieParser from 'cookie-parser';
import { createLimiters } from './rateLimit.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { moduleRoutes } from './routes/modules.js';
import { rackRoutes } from './routes/racks.js';
import { manualRoutes } from './routes/manuals.js';
import { importRoutes } from './routes/imports.js';
import { questionRoutes } from './routes/questions.js';
import { configRoutes } from './routes/config.js';
import { jobRoutes } from './routes/jobs.js';
import { noteRoutes } from './routes/notes.js';
import { exportRoutes } from './routes/exports.js';
import { patchRoutes } from './routes/patches.js';
import { oauthRoutes } from './routes/oauth.js';
import { deviceRoutes } from './routes/devices.js';
import { scopeRoutes } from './routes/scope.js';
import { captureRoutes } from './routes/captures.js';

export function createApp(db, { manualsDir, exportsDir, capturesDir, rateLimit, hub } = {}) {
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
  app.use('/api/modules', moduleRoutes(db, { manualsDir }));
  app.use('/api/racks', rackRoutes(db, { manualsDir }));
  app.use('/api/manuals', manualRoutes(db, { manualsDir }));
  app.use('/api/imports', importRoutes(db));
  app.use('/api/questions', questionRoutes(db));
  app.use('/api/config', configRoutes(db));
  app.use('/api/jobs', jobRoutes(db));
  app.use('/api/notes', noteRoutes(db));
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
