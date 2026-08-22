// /api/racks, one router per sub-resource. A request falls through the
// sub-routers in order until one matches; every route sits behind the same
// auth gate here.
//
// A user's racks. Every route operates on the requesting user's racks only —
// racks (and their module lists) are never visible to other users, the one
// exception being GET /:id for a rack somebody shared.

import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { rackCoreRoutes } from './core.js';
import { rackLayoutRoutes } from './layout.js';
import { rackVideoRoutes } from './videos.js';
import { rackModuleRoutes } from './modules.js';

export function rackRoutes(db, { fetchImpl, runImpl } = {}) {
  const router = Router();
  router.use(requireAuth(db));
  router.use(rackLayoutRoutes(db));
  router.use(rackVideoRoutes(db, { fetchImpl, runImpl }));
  router.use(rackModuleRoutes(db));
  router.use(rackCoreRoutes(db));
  return router;
}
