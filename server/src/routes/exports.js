import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { exportFilePath } from '../services/rackExport.js';
import { asyncHandler } from './asyncHandler.js';

// Serves finished rack-export zips. Strictly owner-only — unlike job rows,
// which admins can also see — because the zip contains the user's private
// notes and questions. Each zip is served once: after the whole file has
// reached the client it is deleted from disk and the job's download link is
// cleared, so getting it again takes a fresh export job.
export function exportRoutes(db, { exportsDir = process.env.EXPORTS_DIR || '/data/exports' } = {}) {
  const { Job } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  router.get('/:jobId', asyncHandler(async (req, res) => {
    const id = Number(req.params.jobId);
    const job = Number.isInteger(id) && id > 0 ? await Job.findByPk(id) : null;
    if (!job || job.type !== 'export_rack' || job.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Export not found' });
    }
    if (job.status !== 'complete') {
      return res.status(400).json({ error: `Export is not ready (status: ${job.status})` });
    }
    let payload = {};
    try {
      payload = JSON.parse(job.payload || '{}');
    } catch {
      // payload is not JSON; treat as already consumed below
    }
    const file = exportFilePath(exportsDir, job.id);
    if (!payload.download || !fs.existsSync(file)) {
      return res.status(404).json({ error: 'Export already downloaded — run the export again' });
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Length', String(fs.statSync(file).size));
    res.set(
      'Content-Disposition',
      `attachment; filename="${String(payload.filename || 'rack.zip').replace(/["\\\r\n]/g, '_')}"`
    );
    // Clean up only once the whole zip was flushed to the client
    // ('finish'); an aborted transfer ('close' without finish) keeps the
    // file so the download can be retried.
    res.on('finish', () => {
      fs.rmSync(file, { force: true });
      const { download, ...rest } = payload;
      Job.update(
        { payload: JSON.stringify({ ...rest, downloaded_at: new Date().toISOString() }) },
        { where: { id: job.id } }
      ).catch(() => {});
    });
    fs.createReadStream(file).pipe(res);
  }));

  return router;
}
