// Questions gain a user review step between scoping and answering: after the
// LLM determines which modules the question applies to, the user can adjust
// the module selection and explicitly attach extra context before the answer
// job runs. These link tables record those explicit attachments.
//
// Manual documents the user attached to the question. This includes the
// shared 'manual' document of in-scope modules (the GUI preselects those,
// but the user may deselect them) as well as their own uploaded documents.

export const description = 'documents a question carries into its answer';

export async function up({ sql }) {
  await sql`
CREATE TABLE question_manuals (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  manual_id INTEGER NOT NULL REFERENCES manuals(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, manual_id)
);

-- Previously answered questions attached as context documents.
CREATE TABLE question_answers (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  source_question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, source_question_id)
);

-- The user's notes attached as context documents.
CREATE TABLE question_notes (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, note_id)
);
`;
}

export async function down({ dropTable }) {
  await dropTable('question_notes', 'question_answers', 'question_manuals');
}
