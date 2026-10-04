// A question answered is a thread begun.
//
// Until now every question stood alone: ask, review the scope, get an answer,
// and the next thing you wanted to know — "and if I take the envelope out of
// that?" — was a new question with no memory of the last, unless the asker
// found the old answer in the review step and attached it by hand. A
// FOLLOW-UP is a question asked under an answered one: it carries the
// thread's scope and attachments (copied as the same link rows, so the
// answering job reads them exactly as it reads any question's) and is
// answered with the conversation so far in front of the model, with no
// scoping pass and no review step of its own. `parent_id` names the ROOT of
// the thread — every follow-up points at the first question, and the thread
// is read in the order it was asked — and goes with it when it is deleted.

export const description = 'follow-up questions threaded under an answered one';

export async function up({ sql }) {
  await sql`
ALTER TABLE questions
  ADD COLUMN parent_id INTEGER REFERENCES questions(id) ON DELETE CASCADE;

COMMENT ON COLUMN questions.parent_id IS
  'the root question this one follows up on; NULL for a question of its own';

CREATE INDEX questions_parent_idx ON questions (parent_id);
`;
}

export async function down({ dropIndex, dropColumn }) {
  await dropIndex('questions_parent_idx');
  await dropColumn('questions', 'parent_id');
}
