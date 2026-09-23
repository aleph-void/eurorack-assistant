// Questions about a rack, and about a system.
//
// A question asked from a module's page names its own scope, and one asked
// from a patch's page brings the patch's modules with it. The two levels
// above a module had no way in: a rack is a case of modules and a system is
// the cases patched together as one instrument, and "what could this case
// do that it is not doing?" is a question about ALL of them. These two link
// tables record which rack or system a question was asked about, so the
// questions page of each can list them — every module of the rack (or of
// every rack in the system) goes into the question's module scope as it is
// created, the same rows a module question writes.

export const description = 'questions about a rack or a system';

export async function up({ sql }) {
  await sql`
CREATE TABLE question_racks (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, rack_id)
);

CREATE INDEX question_racks_rack_idx ON question_racks (rack_id);

CREATE TABLE question_systems (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, system_id)
);

CREATE INDEX question_systems_system_idx ON question_systems (system_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('question_systems');
  await dropTable('question_racks');
}
