// A user's compositions: pieces of music storyboarded as scenes across and
// elements down, and mapped onto the patches that perform them.
//
// The storyboard names no hardware — it is written before the patch exists
// and survives the case being rebuilt. The mapping is where the hardware
// comes in: per patch, each element is bound to the instance, component, bus
// or cable that realises it there.
//
// Compositions are strictly private to their owner.
import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { compositionCoreRoutes } from './core.js';
import { compositionStoryboardRoutes } from './storyboard.js';
import { compositionMappingRoutes } from './mappings.js';

// /api/compositions, one router per sub-resource, all behind one auth gate.
export function compositionRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  router.use(compositionCoreRoutes(db));
  router.use(compositionStoryboardRoutes(db));
  router.use(compositionMappingRoutes(db));
  return router;
}
