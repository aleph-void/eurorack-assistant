// Where sound leaves the system.
//
// Everything a patch is traced through — cables, normals, mults, switches,
// bridges — says where a signal goes, but nothing says where it is SUPPOSED
// to end up: which jack feeds the speakers. Whether a jack does is a fact
// about the studio rather than the module (module records are shared, and
// the same output module is wired to a monitor in one room and sits spare
// in another), so it is recorded on the RACK, and a patch takes its own copy
// at creation the way it copies the rack's arrangement — soft references
// with the jack's name beside them, like a cable's ends — so the patch keeps
// its exits when the case is rebuilt.
//
// The patch generator builds towards these, the flow tracer says whether a
// patch reaches one, and a question about silence is told where the sound
// was meant to come out.

export const description = 'rack outputs, and their copy in each patch';

export async function up({ sql, createIndex }) {
  await sql`
CREATE TABLE rack_outputs (
  id SERIAL PRIMARY KEY,
  rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patch_outputs (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  -- Soft, like a cable's ends: a module_components id, or a
  -- patch_module_ports id on gear declared inside the patch.
  component_id INTEGER,
  component_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
  await createIndex('rack_outputs_unique', 'rack_outputs', ['rack_id', 'module_id', 'component_id'], {
    unique: true,
  });
  await createIndex('patch_outputs_patch_idx', 'patch_outputs', ['patch_id']);
  await createIndex('patch_outputs_unique', 'patch_outputs', ['patch_id', 'patch_module_id', 'component_id'], {
    unique: true,
  });
}

export async function down({ dropTable }) {
  await dropTable('patch_outputs', 'rack_outputs');
}
