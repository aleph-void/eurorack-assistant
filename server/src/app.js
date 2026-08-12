import express from 'express';
import cookieParser from 'cookie-parser';
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

export function createApp(db, { manualsDir, exportsDir } = {}) {
  const app = express();
  app.use(express.json({ limit: '40mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

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

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
