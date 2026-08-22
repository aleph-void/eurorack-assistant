// Asking.
//
//   scope_question  — determine which modules/jacks a question applies to,
//                     then leave the question 'scoped' for the user to review
//   answer_question — ask the LLM with the reviewed scope and attachments
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js.

import { answerQuestion, scopeQuestion } from '../../services/ask.js';

export function createQuestionsHandlers(db, { manualsDir, capturesDir }) {
  async function handleScopeQuestion(job, backend, progress) {
    const { Question } = db.models;
    const record = await Question.findByPk(job.question_id);
    if (!record) throw new Error(`Question ${job.question_id} no longer exists`);
    const question = record.get({ plain: true });
    await Question.update({ status: 'scoping' }, { where: { id: question.id } });
    try {
      // scopeQuestion marks the question 'scoped' once the links are saved.
      await scopeQuestion(db, backend, question, { log: progress });
      progress('scope saved, ready for review');
    } catch (e) {
      await Question.update({ status: 'failed', error: e.message }, { where: { id: question.id } });
      throw e;
    }
  }

  async function handleAnswerQuestion(job, backend, progress) {
    const { Question } = db.models;
    const record = await Question.findByPk(job.question_id);
    if (!record) throw new Error(`Question ${job.question_id} no longer exists`);
    const question = record.get({ plain: true });
    await Question.update({ status: 'answering' }, { where: { id: question.id } });
    try {
      await answerQuestion(db, backend, question, manualsDir, {
        log: progress,
        capturesDir,
      });
      progress('answer saved');
    } catch (e) {
      await Question.update({ status: 'failed', error: e.message }, { where: { id: question.id } });
      throw e;
    }
  }

  return {
    scope_question: handleScopeQuestion,
    answer_question: handleAnswerQuestion,
  };
}
