// Routing switch sections (sequential switches, signal routers). A switch
// connects its COMMON jack to exactly ONE of its STEP jacks at a time
// (stepped by a clock or selected by a control):
//   - common receives a cable, steps send onward  → 1-to-many distributor
//   - steps receive cables, common sends onward   → many-to-one selector
//   - on bidirectional switches (e.g. Doepfer A-151) the SAME jacks do both;
//     the direction is decided by how the patch is cabled.
// Unlike a mult group (simultaneous copies), a switch is exclusive: one
// step is live at a time. Switch-member jacks are exempt from the mult
// cable rules, and the flow tracer draws 'switch' edges for every step the
// patch actually cables, flagging the convergence as selection, not mixing.

export const description = 'routing switch sections';

export async function up({ sql }) {
  await sql`
CREATE TABLE component_switches (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT,
  common_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_switches_module_idx ON component_switches (module_id);

CREATE TABLE component_switch_steps (
  switch_id INTEGER NOT NULL REFERENCES component_switches(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (switch_id, component_id)
);
`;
}

export async function down({ dropTable }) {
  await dropTable('component_switch_steps', 'component_switches');
}
