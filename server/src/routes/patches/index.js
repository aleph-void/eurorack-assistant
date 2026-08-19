// A user's patches. A patch is created FROM a rack but owns a snapshot of the
// rack's contents (patch_modules, one row per module instance): modules can
// move to other racks, be re-analyzed (rewriting their components under new
// ids) or be deleted afterwards, and the patch keeps showing the rack as it
// was. Live module/component rows are joined in at read time for as long as
// they exist — the denormalized name columns take over when they don't.
//
// A patch is not limited to that snapshot, because real patches are not:
// instances carry labels and belong to named buses, off-rack gear (a DAW, a
// MIDI interface, the PA) and modules the rack does not hold take part with
// connection points declared inside the patch, and instances can be wired to
// each other without patch cables — a host and its expander panel, or a pair
// of modules bridging two cases.
//
// Patches are strictly private to their owner.
import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { patchIoRoutes } from './io.js';
import { patchCoreRoutes } from './core.js';
import { patchInstanceRoutes } from './instances.js';
import { patchGroupRoutes } from './groups.js';
import { patchLinkRoutes } from './links.js';
import { patchCableRoutes } from './cables.js';
import { patchSettingRoutes } from './settings.js';

// /api/patches, one router per sub-resource. A request falls through the
// sub-routers in order until one matches; every route sits behind the same
// auth gate here.
export function patchRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  router.use(patchIoRoutes(db));
  router.use(patchCoreRoutes(db));
  router.use(patchInstanceRoutes(db));
  router.use(patchGroupRoutes(db));
  router.use(patchLinkRoutes(db));
  router.use(patchCableRoutes(db));
  router.use(patchSettingRoutes(db));
  return router;
}
