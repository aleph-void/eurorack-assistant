import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { isStalled, resetJobTarget } from '../jobs/worker.js';

// Statuses a job can be stopped or deleted out of while the queue still has
// designs on it. Anything else is already finished.
const ACTIVE = ['pending', 'running'];

export function jobRoutes(db) {
  const { Job, Module, Question } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Listing and retrying are scoped to what the caller may see: their own
  // jobs, or all of them for an admin.
  const visible = (req, where = {}) =>
    req.user.is_admin ? where : { ...where, user_id: req.user.id };

  // Stopping and deleting are owner-only, admin included: an admin can watch
  // and retry the queue, but throwing away work someone else is waiting on is
  // that person's call. Bulk stop/delete therefore never reaches past the
  // caller's own jobs either.
  const owned = (req, where = {}) => ({ ...where, user_id: req.user.id });
  const isOwner = (req, job) => job.user_id === req.user.id;

  // A job is stopped by taking it off the queue rather than by interrupting
  // its runner — handlers have no cancellation to offer. A running job's
  // process is left to finish and find its row gone from under it (see
  // `abandoned` in the worker), which costs at most one wasted attempt.
  async function stopJob(job, message) {
    const [, rows] = await Job.update(
      { status: 'cancelled', error: message, worker_id: null, heartbeat_at: null, started_at: null },
      { where: { id: job.id, status: ACTIVE }, returning: true }
    );
    if (!rows || !rows[0]) return null;
    await resetJobTarget(db, job.get({ plain: true }), 'cancelled', message);
    return rows[0].get({ plain: true });
  }

  // Jobs are strictly private: every job is stamped with the user who caused
  // it, and only that user (or an admin) can see or retry it.
  router.get('/', async (req, res, next) => {
    try {
      const jobs = await Job.findAll({
        where: visible(req),
        include: [
          { model: Module, attributes: ['manufacturer', 'name'], required: false },
          { model: Question, attributes: ['prompt'], required: false },
        ],
        order: [['id', 'DESC']],
      });
      res.json(
        jobs.map((job) => {
          const { id, type, status, attempts, error, created_at, updated_at, module_id, question_id } =
            job;
          // export_rack jobs carry their target rack and, while the zip is
          // still on disk, the download link in the payload.
          let rack_name = null;
          let download = null;
          if (job.payload) {
            try {
              const payload = JSON.parse(job.payload);
              rack_name = payload.rack_name ?? null;
              download = payload.download ?? null;
            } catch {
              // payload is not JSON
            }
          }
          return {
            id,
            type,
            status,
            attempts,
            error,
            created_at,
            updated_at,
            module_id,
            question_id,
            module_manufacturer: job.Module?.manufacturer ?? null,
            module_name: job.Module?.name ?? null,
            question_prompt: job.Question?.prompt ?? null,
            rack_name,
            // Running, but nothing has reported progress for a long time —
            // the worker normally reclaims these on its next pass, and the
            // client offers a Retry in the meantime.
            stalled: isStalled(job),
            // Stopping, deleting and downloading are all owner-only, so an
            // admin looking at someone else's job gets neither the controls
            // nor a dead link to the zip (which holds private notes).
            own: job.user_id === req.user.id,
            download: job.user_id === req.user.id ? download : null,
          };
        })
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/retry', async (req, res, next) => {
    try {
      const job = await Job.findByPk(Number(req.params.id));
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!req.user.is_admin && job.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Job not found' });
      }
      // A stalled job is retryable too: its worker died holding it, so
      // nothing is going to finish it. Anything else still running is left
      // alone — retrying it would run the work twice.
      if (job.status !== 'failed' && !isStalled(job)) {
        return res.status(400).json({ error: 'Only failed or stalled jobs can be retried' });
      }
      await job.update({
        status: 'pending',
        error: null,
        worker_id: null,
        heartbeat_at: null,
        started_at: null,
      });
      res.json({ ...job.get({ plain: true }), stalled: false });
    } catch (e) {
      next(e);
    }
  });

  // Take every queued and in-flight job off the queue. Registered before the
  // per-job routes so 'stop-all' is never read as an id.
  router.post('/stop-all', async (req, res, next) => {
    try {
      const jobs = await Job.findAll({ where: owned(req, { status: ACTIVE }) });
      let stopped = 0;
      for (const job of jobs) {
        if (await stopJob(job, 'stopped by user')) stopped += 1;
      }
      res.json({ stopped });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/stop', async (req, res, next) => {
    try {
      const job = await Job.findByPk(Number(req.params.id));
      if (!job || !isOwner(req, job)) return res.status(404).json({ error: 'Job not found' });
      const stopped = await stopJob(job, 'stopped by user');
      if (!stopped) return res.status(400).json({ error: 'Only queued or running jobs can be stopped' });
      res.json({ ...stopped, stalled: false });
    } catch (e) {
      next(e);
    }
  });

  // Clear the whole list. Active jobs are stopped on the way out so their
  // targets are not left claiming that work is still under way.
  router.delete('/', async (req, res, next) => {
    try {
      const jobs = await Job.findAll({ where: owned(req) });
      for (const job of jobs) {
        if (ACTIVE.includes(job.status)) await stopJob(job, 'stopped by user');
      }
      const deleted = await Job.destroy({ where: owned(req) });
      res.json({ deleted });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const job = await Job.findByPk(Number(req.params.id));
      if (!job || !isOwner(req, job)) return res.status(404).json({ error: 'Job not found' });
      // Deleting an active job stops it too: otherwise its module or question
      // would sit on 'analyzing' with no job left to explain why.
      if (ACTIVE.includes(job.status)) await stopJob(job, 'stopped by user');
      await job.destroy();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
