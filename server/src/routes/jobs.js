import { Router } from 'express';
import { requireAuth } from '../auth.js';

export function jobRoutes(db) {
  const { Job, Module, Question } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Jobs are strictly private: every job is stamped with the user who caused
  // it, and only that user (or an admin) can see or retry it.
  router.get('/', async (req, res, next) => {
    try {
      const jobs = await Job.findAll({
        where: req.user.is_admin ? undefined : { user_id: req.user.id },
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
      if (job.status !== 'failed') {
        return res.status(400).json({ error: 'Only failed jobs can be retried' });
      }
      await job.update({ status: 'pending', error: null });
      res.json(job);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
