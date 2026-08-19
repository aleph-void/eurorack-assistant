import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { moduleCoreRoutes } from './core.js';
import { moduleDetailRoutes } from './detail.js';
import { moduleSignalRoutes } from './signals.js';
import { moduleExpanderRoutes } from './expanders.js';
import { moduleComponentRoutes } from './components.js';
import { modulePanelRoutes } from './panel.js';
import { moduleManualRoutes } from './manuals.js';

// /api/modules, one router per sub-resource. A request falls through the
// sub-routers in order until one matches; every route sits behind the same
// auth gate here.
export function moduleRoutes(
  db,
  {
    manualsDir = process.env.MANUALS_DIR || '/data/manuals',
    panelsDir = process.env.PANELS_DIR || '/data/panels',
    fetchImpl = fetch,
  } = {}
) {
  const router = Router();
  router.use(requireAuth(db));
  router.use(moduleCoreRoutes(db, { manualsDir }));
  router.use(moduleDetailRoutes(db));
  router.use(moduleSignalRoutes(db));
  router.use(moduleExpanderRoutes(db));
  router.use(moduleComponentRoutes(db));
  router.use(modulePanelRoutes(db, { panelsDir, fetchImpl }));
  router.use(moduleManualRoutes(db, { manualsDir }));
  return router;
}
