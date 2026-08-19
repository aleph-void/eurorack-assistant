import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { isStalled, resetJobTarget } from '../jobs/worker.js';
import { getQueuePause, resumeQueue } from '../services/config.js';
import { asyncHandler } from './asyncHandler.js';

// Statuses a job can be stopped or deleted out of while the queue still has
// designs on it. Anything else is already finished.
const ACTIVE = ['pending', 'running'];

export function jobRoutes(db, { bus = null } = {}) {
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
  router.get('/', asyncHandler(async (req, res) => {
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
  }));

  // Is the queue running? It stops itself when the LLM provider reports the
  // subscription is out of tokens, and starts again of its own accord when
  // the limit is due to lift. Registered before the per-job routes so
  // 'queue' is never read as an id.
  router.get('/queue', asyncHandler(async (req, res) => {
    const pause = await getQueuePause(db);
    res.json({ paused: pause.paused, until: pause.paused ? pause.until : null, reason: pause.paused ? pause.reason : '' });
  }));

  // Start the queue again by hand, for a limit that lifted early or a pause
  // the user disagrees with. Not admin-only: the pause blocks everyone's
  // work, and anyone who can queue a job can find out the same way whether
  // there are tokens left.
  router.post('/queue/resume', asyncHandler(async (req, res) => {
    await resumeQueue(db);
    // Everyone is looking at the same paused queue, so everyone is told.
    bus?.publishAll?.({ kind: 'queue', event: 'resumed', paused: false, until: null, reason: '' });
    res.json({ paused: false, until: null, reason: '' });
  }));

  router.post('/:id/retry', asyncHandler(async (req, res) => {
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
  }));

  // Take every queued and in-flight job off the queue. Registered before the
  // per-job routes so 'stop-all' is never read as an id.
  router.post('/stop-all', asyncHandler(async (req, res) => {
    const jobs = await Job.findAll({ where: owned(req, { status: ACTIVE }) });
    let stopped = 0;
    for (const job of jobs) {
      if (await stopJob(job, 'stopped by user')) stopped += 1;
    }
    res.json({ stopped });
  }));

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const job = await Job.findByPk(Number(req.params.id));
    if (!job || !isOwner(req, job)) return res.status(404).json({ error: 'Job not found' });
    const stopped = await stopJob(job, 'stopped by user');
    if (!stopped) return res.status(400).json({ error: 'Only queued or running jobs can be stopped' });
    res.json({ ...stopped, stalled: false });
  }));

  // Clear the whole list. Active jobs are stopped on the way out so their
  // targets are not left claiming that work is still under way.
  router.delete('/', asyncHandler(async (req, res) => {
    const jobs = await Job.findAll({ where: owned(req) });
    for (const job of jobs) {
      if (ACTIVE.includes(job.status)) await stopJob(job, 'stopped by user');
    }
    const deleted = await Job.destroy({ where: owned(req) });
    res.json({ deleted });
  }));

  // Clear out the jobs the user stopped. Nothing here is live — a cancelled
  // job is finished with — so there is nothing to stop on the way out.
  // Registered before the per-job route so 'cancelled' is never read as an id.
  router.delete('/cancelled', asyncHandler(async (req, res) => {
    const deleted = await Job.destroy({ where: owned(req, { status: 'cancelled' }) });
    res.json({ deleted });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const job = await Job.findByPk(Number(req.params.id));
    if (!job || !isOwner(req, job)) return res.status(404).json({ error: 'Job not found' });
    // Deleting an active job stops it too: otherwise its module or question
    // would sit on 'analyzing' with no job left to explain why.
    if (ACTIVE.includes(job.status)) await stopJob(job, 'stopped by user');
    await job.destroy();
    res.json({ ok: true });
  }));

  return router;
}
