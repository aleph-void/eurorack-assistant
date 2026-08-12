import { Router } from 'express';
import { requireAuth } from '../auth.js';

export function jobRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));

  // Jobs are strictly private: every job is stamped with the user who caused
  // it, and only that user (or an admin) can see or retry it.
  router.get('/', async (req, res, next) => {
    try {
      const baseQuery = `
        SELECT j.id, j.type, j.status, j.attempts, j.error, j.created_at, j.updated_at,
               j.module_id, j.question_id,
               m.manufacturer AS module_manufacturer, m.name AS module_name,
               q.prompt AS question_prompt
        FROM jobs j
        LEFT JOIN modules m ON m.id = j.module_id
        LEFT JOIN questions q ON q.id = j.question_id`;
      const { rows } = req.user.is_admin
        ? await db.query(`${baseQuery} ORDER BY j.id DESC`)
        : await db.query(`${baseQuery} WHERE j.user_id = $1 ORDER BY j.id DESC`, [req.user.id]);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/retry', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = rows[0];
      if (!req.user.is_admin && job.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Job not found' });
      }
      if (job.status !== 'failed') {
        return res.status(400).json({ error: 'Only failed jobs can be retried' });
      }
      const { rows: updated } = await db.query(
        `UPDATE jobs SET status = 'pending', error = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      res.json(updated[0]);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
