// Where sound leaves a SYSTEM.
//
// Migration 047 recorded the exits on the rack, which is right for a rack
// that stands alone and wrong for one that is part of a system: a studio of
// three cases has one pair of monitors, fed from whichever case the output
// module happens to sit in, and a patch of the whole system is patched
// towards THAT — not towards an exit per case. So a system keeps its own
// list, one row per jack, each naming the rack the module stands in (the
// same module may be racked in two cases of one system, and only one of
// them is wired to the speakers). A patch of a system copies these; a patch
// of a lone rack still copies the rack's.
//
// The racks already in a system bring the exits marked on them, so nothing
// marked under 047 goes missing. Their rack rows are kept: they are what the
// rack answers with again if it ever leaves the system.

export const description = 'system outputs, seeded from the rack outputs of racks in a system';

export async function up({ sql, createIndex }) {
  await sql`
CREATE TABLE system_outputs (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_outputs (system_id, rack_id, module_id, component_id, position)
SELECT r.system_id, ro.rack_id, ro.module_id, ro.component_id, ro.position
FROM rack_outputs ro
JOIN racks r ON r.id = ro.rack_id
WHERE r.system_id IS NOT NULL;
`;
  await createIndex('system_outputs_system_idx', 'system_outputs', ['system_id']);
  await createIndex(
    'system_outputs_unique',
    'system_outputs',
    ['system_id', 'rack_id', 'module_id', 'component_id'],
    { unique: true }
  );
}

export async function down({ dropTable }) {
  await dropTable('system_outputs');
}
