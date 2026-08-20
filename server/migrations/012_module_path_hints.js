// What a manual says that cannot be stored yet.
//
// Analysis runs per module, but manuals do not respect that boundary. One PDF
// routinely documents a host AND its expander (Humble Audio's Quad Operator
// manual covers the Algo extension; the Bohm manual covers Groove and
// Performer; the Atlantix manual describes the Atlx panel), and the signal
// paths it describes run between the two panels: "the VCF input appears at
// the Atlx LP output". Such a path cannot be resolved while analyzing the
// host, because the expander's components belong to a different module record
// that may not be imported, analyzed or linked yet.
//
// Rather than dropping what the manual plainly says, the name-based row is
// kept here and materialized whenever resolution becomes possible: when the
// other panel is analyzed, or when the two modules are linked. Rows are NOT
// deleted once materialized — re-analyzing the other panel rewrites its
// components under new ids, cascading the resolved rows away, and the hint is
// what lets them come back.
//
//   kind 'route'         — payload { input, input_panel, output, output_panel,
//                          condition, alt_group, description }
//   kind 'normalization' — payload { target, target_panel, source,
//                          source_panel, source_label, condition, alt_group,
//                          break_jack, break_on, description }
//   kind 'expander'      — payload { name, role } naming a panel the manual
//                          says belongs with this module, so the two module
//                          records can be linked automatically once both
//                          exist.
//
// payload is TEXT holding JSON (jsonb parameters break the pg-mem test
// database, as with jobs.payload). Hints are rewritten on every analysis.

export const description = 'unresolved path hints read out of a manual';

export async function up({ sql }) {
  await sql`
CREATE TABLE module_path_hints (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX module_path_hints_module_idx ON module_path_hints (module_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('module_path_hints');
}
