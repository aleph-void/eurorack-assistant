// Questions about a patch.
//
// Until now a question could be about modules and their jacks, with manuals,
// previous answers, notes and oscilloscope captures attached. But the thing a
// user most often wants to ask about is the patch in front of them — "why is
// there no sound at the output", "what would make this sequence swing" — and
// that question is unanswerable without the cables, the control settings, the
// normalled connections the patch leaves intact and the signal flow they add
// up to. A patch attaches to a question like any other document; its modules
// come into scope with it.

export const description = 'questions about a patch';

export async function up({ sql }) {
  await sql`
CREATE TABLE question_patches (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  -- Patches are deleted outright rather than kept as snapshots, so a question
  -- about one loses the attachment with it. The answer text already written
  -- is unaffected.
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, patch_id)
);

CREATE INDEX question_patches_patch_idx ON question_patches (patch_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('question_patches');
}
