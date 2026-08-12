import { Router } from 'express';
import { requireAuth } from '../auth.js';

export function questionRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, prompt, status, error, created_at, answered_at
         FROM questions WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT * FROM questions WHERE id = $1 AND user_id = $2',
        [Number(req.params.id), req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Question not found' });
      const question = rows[0];
      const { rows: modules } = await db.query(
        `SELECT m.id, m.manufacturer, m.name
         FROM question_modules qm JOIN modules m ON m.id = qm.module_id
         WHERE qm.question_id = $1 ORDER BY m.manufacturer, m.name`,
        [question.id]
      );
      const { rows: components } = await db.query(
        `SELECT mc.id, mc.name, mc.type, mc.module_id,
                m.manufacturer AS module_manufacturer, m.name AS module_name
         FROM question_components qc
         JOIN module_components mc ON mc.id = qc.component_id
         JOIN modules m ON m.id = mc.module_id
         WHERE qc.question_id = $1 ORDER BY mc.id`,
        [question.id]
      );
      res.json({ ...question, modules, components });
    } catch (e) {
      next(e);
    }
  });

  // Questions are answered asynchronously by the job worker; the client polls.
  router.post('/', async (req, res, next) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      const { rows: moduleCount } = await db.query(
        'SELECT COUNT(*)::int AS count FROM user_modules WHERE user_id = $1',
        [req.user.id]
      );
      if (moduleCount[0].count === 0) {
        return res.status(400).json({ error: 'Import some modules before asking questions' });
      }

      const { rows } = await db.query(
        `INSERT INTO questions (user_id, prompt, status) VALUES ($1, $2, 'pending') RETURNING *`,
        [req.user.id, prompt]
      );
      const question = rows[0];
      await db.query(
        `INSERT INTO jobs (type, user_id, question_id, status)
         VALUES ('answer_question', $1, $2, 'pending')`,
        [req.user.id, question.id]
      );
      res.status(201).json(question);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
