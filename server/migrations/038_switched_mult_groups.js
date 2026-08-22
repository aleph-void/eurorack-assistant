// Switched multiples: a mult section whose MEMBERS are decided by a switch.
//
// module_components.group_label (migration 005) says which mult section a
// bidirectional jack belongs to, as an unconditional fact about the hardware.
// That covers a passive mult, and it covers a 2x2 mult whose two halves are
// wired apart at the factory. It does not cover the Doepfer A-182-1, whose
// eight jacks sit on two internal buses with a three-position toggle beside
// each one: up puts that jack on bus 1, down puts it on bus 2, and the middle
// position takes it off both. Which jacks are copies of each other is then a
// fact about the PATCH — the toggle positions it records — not about the
// module, and there is no single label that could be stored for the jack.
//
// Same shape as the conditional routes and normalizations of migration 008:
// a row is live while its control is at its value, and a patch records
// control positions in patch_settings. One row per (jack, position):
//
//   OUT 1  SW 1 = up    → group '1'
//   OUT 1  SW 1 = down  → group '2'
//   OUT 1  SW 1 = off   → group NULL   (on no bus at all)
//
// A jack with no rows here keeps its group_label, so every mult that worked
// before works unchanged; a jack with rows takes its group from the position
// the patch records, is in NO section when the position is one that takes it
// off the buses, and — when the patch has not recorded that toggle at all —
// is one of the possibilities the tracer marks exclusive, exactly as an
// unset conditional route is.

export const description = 'switched mult groups (A-182-1 style)';

export async function up({ sql }) {
  await sql`
CREATE TABLE component_mult_groups (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- The bidirectional jack whose section this decides.
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  -- The section it joins in this position. NULL is a real answer: the jack
  -- is on no bus while the control sits here.
  group_label TEXT,
  -- The control that decides, and the position it has to be in. Nullable so
  -- an unconditional override stays possible, but the API asks for one: a
  -- jack whose section never changes says so with its group_label.
  condition_component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE,
  condition_value TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_mult_groups_module_idx ON component_mult_groups (module_id);
CREATE INDEX component_mult_groups_component_idx ON component_mult_groups (component_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('component_mult_groups');
}
