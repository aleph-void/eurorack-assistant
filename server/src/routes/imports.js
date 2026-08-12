import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { enqueueJob } from '../jobs/worker.js';
import { DEFAULT_RACK_NAME } from '../services/racks.js';

// Imports are fully asynchronous: the request only validates the input shape
// and queues an `import` job. The worker parses the list, creates module
// records, and chains find_manual / analyze_manual jobs, publishing progress
// over the WebSocket.
export function importRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));

  // Body: { type: 'csv' | 'text' | 'modulargrid', content?, url?, rack? }
  // Modules land in the named rack (created on first use); a missing or blank
  // rack name falls back to the default 'main rack'.
  router.post('/', async (req, res, next) => {
    try {
      const { type, content, url } = req.body || {};
      const rack = String(req.body?.rack ?? '').trim() || DEFAULT_RACK_NAME;
      if (type === 'csv' || type === 'text') {
        if (!content || !String(content).trim()) {
          return res.status(400).json({ error: 'content is required' });
        }
      } else if (type === 'modulargrid') {
        if (!url || !String(url).includes('modulargrid')) {
          return res.status(400).json({ error: 'a ModularGrid rack url is required' });
        }
      } else {
        return res.status(400).json({ error: "type must be 'csv', 'text', or 'modulargrid'" });
      }

      const job = await enqueueJob(db, 'import', {
        userId: req.user.id,
        payload: { type, content, url, rack },
      });
      res.status(202).json({ job_id: job.id, status: job.status });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
