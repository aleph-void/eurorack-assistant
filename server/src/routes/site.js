import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getSiteConfig } from '../services/config.js';
import { asyncHandler } from './asyncHandler.js';

// The settings the app draws for EVERY signed-in user — today the Discord
// invite in the footer. Readable while a password change is still owed,
// because the footer is on that page too; written only through the admin's
// /api/config.
export function siteRoutes(db) {
  const router = Router();
  router.use(requireAuth(db, { allowPasswordChange: true }));

  router.get('/', asyncHandler(async (req, res) => {
    res.json(await getSiteConfig(db));
  }));

  return router;
}
