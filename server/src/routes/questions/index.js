// /api/questions, one router per stage. A request falls through the
// sub-routers in order until one matches; every route sits behind the same
// auth gate here.
//
// Questions go through a review step: POST / queues a scope_question job
// that determines which modules (and specific components) the question
// applies to — unless the question was asked FROM a module's page, which
// says the same thing without a model (module_ids/component_ids on the POST,
// which is then created 'scoped' with no job at all). Once the question is
// 'scoped' the user reviews the module and component selection and picks
// attachments (manual documents, previous answers, notes, oscilloscope
// captures) via GET /:id/options, and POST /:id/answer saves the selection
// and queues the answer_question job.

import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { questionCoreRoutes } from './core.js';
import { questionReviewRoutes } from './review.js';

export function questionRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  router.use(questionReviewRoutes(db));
  router.use(questionCoreRoutes(db));
  return router;
}
