import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, fakeBackend, insertModule, login, PDF_HASH } from './helpers.js';
import { answerQuestion, conversationDocument } from '../src/services/ask.js';

// Follow-up questions (migration 052): a thread is a root question and the
// follow-ups asked under it, each answered with the conversation so far.

async function withAnsweredQuestion() {
  const fixture = await createTestApp();
  const { rows } = await fixture.db.query("SELECT id FROM users WHERE username = 'alice'");
  fixture.alice = rows[0];
  fixture.module = await insertModule(fixture.db, fixture.alice.id, {
    manual_hash: PDF_HASH,
    manual_status: 'found',
  });
  const { rows: jack } = await fixture.db.query(
    `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'output_jack', 'EOR')
     RETURNING id`,
    [fixture.module.id]
  );
  fixture.jack = jack[0];
  const { Question, QuestionModule, QuestionComponent } = fixture.db.models;
  fixture.root = await Question.create({
    user_id: fixture.alice.id,
    prompt: 'What does EOR do?',
    status: 'answered',
    answer: 'It fires at the end of the rise.',
    answered_at: new Date(),
  });
  await QuestionModule.create({ question_id: fixture.root.id, module_id: fixture.module.id });
  await QuestionComponent.create({ question_id: fixture.root.id, component_id: fixture.jack.id });
  return fixture;
}

const ask = (fixture, id, prompt) =>
  request(fixture.app)
    .post(`/api/questions/${id}/followups`)
    .set('Cookie', fixture.aliceCookie)
    .send({ prompt });

describe('asking a follow-up', () => {
  it('copies the scope and attachments onto a pending question and queues the answer', async () => {
    const fixture = await withAnsweredQuestion();
    const { db, root } = fixture;

    const res = await ask(fixture, root.id, 'And the EOC?');
    expect(res.status).toBe(201);
    expect(res.body.parent_id).toBe(root.id);
    expect(res.body.status).toBe('pending');

    const { rows: modules } = await db.query(
      'SELECT module_id FROM question_modules WHERE question_id = $1',
      [res.body.id]
    );
    expect(modules.map((m) => m.module_id)).toEqual([fixture.module.id]);
    const { rows: components } = await db.query(
      'SELECT component_id FROM question_components WHERE question_id = $1',
      [res.body.id]
    );
    expect(components.map((c) => c.component_id)).toEqual([fixture.jack.id]);
    const { rows: jobs } = await db.query(
      'SELECT type, status FROM jobs WHERE question_id = $1',
      [res.body.id]
    );
    expect(jobs).toEqual([{ type: 'answer_question', status: 'pending' }]);

    // Blank, or asked of a question that is not yours: refused.
    expect((await ask(fixture, root.id, '   ')).status).toBe(400);
    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    const foreign = await request(fixture.app)
      .post(`/api/questions/${root.id}/followups`)
      .set('Cookie', bobCookie)
      .send({ prompt: 'Mine?' });
    expect(foreign.status).toBe(404);
  });

  it('waits for the root to be answered and for the last follow-up to land', async () => {
    const fixture = await withAnsweredQuestion();
    const { db, root } = fixture;
    const { Question } = db.models;

    const unanswered = await Question.create({
      user_id: fixture.alice.id,
      prompt: 'Later?',
      status: 'scoped',
    });
    const early = await ask(fixture, unanswered.id, 'Already?');
    expect(early.status).toBe(409);

    const first = await ask(fixture, root.id, 'And the EOC?');
    expect(first.status).toBe(201);
    const second = await ask(fixture, root.id, 'And the trigger input?');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/still being answered/);

    // A failed follow-up does not hold the thread up; an answered one neither.
    await Question.update({ status: 'failed', error: 'boom' }, { where: { id: first.body.id } });
    const third = await ask(fixture, root.id, 'And the trigger input?');
    expect(third.status).toBe(201);

    // A follow-up's id means its thread: asking under it lands under the root.
    await Question.update(
      { status: 'answered', answer: 'A trigger.' },
      { where: { id: third.body.id } }
    );
    const fourth = await ask(fixture, third.body.id, 'Rising edge?');
    expect(fourth.status).toBe(201);
    expect(fourth.body.parent_id).toBe(root.id);
  });

  it('serves the thread with its root, keeps follow-ups off the list, and deletes them with it', async () => {
    const fixture = await withAnsweredQuestion();
    const { app, db, root, aliceCookie } = fixture;
    const { Question } = db.models;

    const first = await ask(fixture, root.id, 'And the EOC?');
    await Question.update(
      { status: 'answered', answer: 'At the end of the fall.', answered_at: new Date() },
      { where: { id: first.body.id } }
    );
    const second = await ask(fixture, root.id, 'Both at once?');

    const detail = await request(app).get(`/api/questions/${root.id}`).set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.thread.map((q) => [q.prompt, q.status, q.answer])).toEqual([
      ['And the EOC?', 'answered', 'At the end of the fall.'],
      ['Both at once?', 'pending', null],
    ]);

    const list = await request(app).get('/api/questions').set('Cookie', aliceCookie);
    expect(list.body.map((q) => q.id)).toEqual([root.id]);
    const byModule = await request(app)
      .get(`/api/questions?module_id=${fixture.module.id}`)
      .set('Cookie', aliceCookie);
    expect(byModule.body.map((q) => q.id)).toEqual([root.id]);

    // A follow-up is not offered as a previous answer in its own right.
    const scoped = await Question.create({
      user_id: fixture.alice.id,
      prompt: 'Another?',
      status: 'scoped',
    });
    await db.models.QuestionModule.create({ question_id: scoped.id, module_id: fixture.module.id });
    const options = await request(app)
      .get(`/api/questions/${scoped.id}/options`)
      .set('Cookie', aliceCookie);
    expect(options.body.answers.map((a) => a.id)).toEqual([root.id]);
    const attachFollowUp = await request(app)
      .post(`/api/questions/${scoped.id}/answer`)
      .set('Cookie', aliceCookie)
      .send({ module_ids: [fixture.module.id], answer_ids: [first.body.id] });
    expect(attachFollowUp.status).toBe(400);

    const gone = await request(app).delete(`/api/questions/${root.id}`).set('Cookie', aliceCookie);
    expect(gone.status).toBe(200);
    const left = await Question.findAll({ where: { id: [root.id, first.body.id, second.body.id] } });
    expect(left).toEqual([]);
  });
});

describe('answering a follow-up', () => {
  it('attaches the conversation so far and says so in the prompt', async () => {
    const fixture = await withAnsweredQuestion();
    const { db, root } = fixture;
    const { Question } = db.models;

    const first = await ask(fixture, root.id, 'And the EOC?');
    await Question.update(
      { status: 'answered', answer: 'At the end of the fall.' },
      { where: { id: first.body.id } }
    );
    const failed = await ask(fixture, root.id, 'Lost?');
    await Question.update({ status: 'failed', error: 'boom' }, { where: { id: failed.body.id } });
    const asked = await ask(fixture, root.id, 'Both at once?');

    const backend = fakeBackend({ answerWithDocuments: 'Never: one ends as the other begins.' });
    const answered = await answerQuestion(
      db,
      backend,
      (await Question.findByPk(asked.body.id)).get({ plain: true }),
      fixture.manualsDir,
      { capturesDir: fixture.capturesDir }
    );
    expect(answered.status).toBe('answered');
    expect(answered.answer).toBe('Never: one ends as the other begins.');

    const [prompt, , textDocs] = backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('the conversation so far');
    expect(prompt).toContain('This question is a follow-up');
    expect(prompt).toContain('Question: Both at once?');
    const conversation = textDocs.find((d) => d.name === 'conversation.md');
    expect(conversation.text).toBe(
      '# Question\n\nWhat does EOR do?\n\n# Answer\n\nIt fires at the end of the rise.\n\n' +
        '# Follow-up question\n\nAnd the EOC?\n\n# Answer\n\nAt the end of the fall.'
    );
    // The failed turn said nothing, and the one being answered is not its
    // own context.
    expect(conversation.text).not.toContain('Lost?');
    expect(conversation.text).not.toContain('Both at once?');
  });

  it('attaches a previous answer with the thread it grew', async () => {
    const fixture = await withAnsweredQuestion();
    const { db, root } = fixture;
    const { Question, QuestionModule, QuestionAnswer } = db.models;

    const first = await ask(fixture, root.id, 'And the EOC?');
    await Question.update(
      { status: 'answered', answer: 'At the end of the fall.' },
      { where: { id: first.body.id } }
    );
    const citing = await Question.create({
      user_id: fixture.alice.id,
      prompt: 'Can I chain them?',
      status: 'pending',
    });
    await QuestionModule.create({ question_id: citing.id, module_id: fixture.module.id });
    await QuestionAnswer.create({ question_id: citing.id, source_question_id: root.id });

    const backend = fakeBackend({ answerWithDocuments: 'Yes.' });
    await answerQuestion(db, backend, citing.get({ plain: true }), fixture.manualsDir, {
      capturesDir: fixture.capturesDir,
    });
    const [prompt, , textDocs] = backend.calls.answerWithDocuments[0];
    expect(prompt).not.toContain('follow-up');
    const previous = textDocs.find((d) => d.name === `previous-answer-${root.id}.md`);
    expect(previous.text).toContain('And the EOC?');
    expect(previous.text).toContain('At the end of the fall.');
  });

  it('writes the conversation as question and answer turns', () => {
    const doc = conversationDocument(
      { prompt: 'A?', answer: 'A.' },
      [
        { prompt: 'B?', answer: null },
        { prompt: 'C?', answer: 'C.' },
      ]
    );
    expect(doc).toBe('# Question\n\nA?\n\n# Answer\n\nA.\n\n# Follow-up question\n\nC?\n\n# Answer\n\nC.');
  });
});
