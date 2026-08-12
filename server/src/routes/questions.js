import { Router } from 'express';
import { requireAuth } from '../auth.js';

export function questionRoutes(db) {
  const { Question, QuestionModule, QuestionComponent, Module, ModuleComponent, UserModule, Job } =
    db.models;
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', async (req, res, next) => {
    try {
      const questions = await Question.findAll({
        where: { user_id: req.user.id },
        attributes: ['id', 'prompt', 'status', 'error', 'created_at', 'answered_at'],
        order: [
          ['created_at', 'DESC'],
          ['id', 'DESC'],
        ],
      });
      res.json(questions);
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const question = await Question.findOne({
        where: { id: Number(req.params.id), user_id: req.user.id },
      });
      if (!question) return res.status(404).json({ error: 'Question not found' });
      const links = await QuestionModule.findAll({
        where: { question_id: question.id },
        include: Module,
        order: [
          [Module, 'manufacturer', 'ASC'],
          [Module, 'name', 'ASC'],
        ],
      });
      const componentLinks = await QuestionComponent.findAll({
        where: { question_id: question.id },
        include: [{ model: ModuleComponent, include: [Module] }],
        order: [[ModuleComponent, 'id', 'ASC']],
      });
      res.json({
        ...question.get({ plain: true }),
        modules: links.map(({ Module: m }) => ({
          id: m.id,
          manufacturer: m.manufacturer,
          name: m.name,
        })),
        components: componentLinks.map(({ ModuleComponent: mc }) => ({
          id: mc.id,
          name: mc.name,
          type: mc.type,
          module_id: mc.module_id,
          module_manufacturer: mc.Module.manufacturer,
          module_name: mc.Module.name,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // Questions are answered asynchronously by the job worker; the client polls.
  router.post('/', async (req, res, next) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      const moduleCount = await UserModule.count({ where: { user_id: req.user.id } });
      if (moduleCount === 0) {
        return res.status(400).json({ error: 'Import some modules before asking questions' });
      }

      const question = await Question.create({
        user_id: req.user.id,
        prompt,
        status: 'pending',
      });
      await Job.create({
        type: 'answer_question',
        user_id: req.user.id,
        question_id: question.id,
        status: 'pending',
      });
      res.status(201).json(question);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
