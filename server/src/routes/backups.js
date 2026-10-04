// What the daily backup reported, for the admin's eyes.
//
// There is no POST here on purpose. A backup run is written by
// scripts/report-backup.js, which backup-to-s3.sh runs INSIDE the server
// container as the run ends — it already has the database, and an HTTP
// route the host could post to would need a credential of its own for a
// caller that is the same machine. Reading is the admin's alone: a run's
// message is the tail of a host log, which names paths, buckets and whatever
// an upload error chose to say.

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { backupStatus } from '../services/backups.js';
import { asyncHandler } from './asyncHandler.js';

export function backupRoutes(db) {
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

  // The status and the recent runs in one answer: the banner reads
  // `problem`, the Backups page reads everything, and the list is thirty
  // rows at most, so there is nothing to page.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await backupStatus(db));
    })
  );

  return router;
}
