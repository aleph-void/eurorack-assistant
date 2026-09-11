// A composition, storyboarded; and what performs it.
//
// Everything before this is about the HARDWARE and a MOMENT of it: a module
// is what the manual says it is, a patch is the cables and settings of one
// arrangement of the case. Neither says what the music DOES over the next
// eight minutes — where the bass comes in, when the filter opens, which
// scene the drums drop out of. A performer scribbles that on paper and props
// it against the case. This is that piece of paper.
//
// A COMPOSITION is storyboarded as a grid: its SCENES in order across the
// top (intro, build, drop, outro — each with what happens in it and how
// long it runs), its ELEMENTS down the side (the bass, the kick, the wash,
// the filter you ride — the parts the piece is made of), and in each CELL
// what that element does in that scene (enters, holds, changes, exits, with
// a note saying how). A cell that does not exist is an element that is not
// playing then. The storyboard says nothing about hardware on purpose: it is
// written before the patch exists and survives the case being rebuilt.
//
// A composition is then MAPPED ONTO A PATCH. The pair itself is a record
// (composition_patches: a piece can be performed on more than one patch, and
// "the way I play it on the small case" has notes of its own), and under it
// each element is bound to what realises it in that patch: a module instance
// (the bass IS Maths #1), one component of an instance (the filter you ride
// IS Ripples' cutoff), a bus (the rhythm section IS the Drums group) or a
// cable (the sidechain IS this cable). One element may need several of them.
//
// The targets inside the patch are SOFT references with the target's name
// snapshotted beside them, the way a patch keeps its own module and
// component names: an instance removed from the patch leaves a mapping that
// still reads "Maths #1 (no longer in the patch)" and asks to be re-bound,
// rather than a row that vanished. The composition and the patch themselves
// are hard references — a mapping onto a deleted patch is nothing at all.

export const description = 'compositions, their storyboards and their mappings onto patches';

export async function up({ sql, createIndex }) {
  await sql`
CREATE TABLE compositions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- What the piece runs at, when it runs at one tempo. Advisory: nothing
  -- here clocks anything.
  tempo_bpm REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One frame of the storyboard, in the order it is played.
CREATE TABLE composition_scenes (
  id SERIAL PRIMARY KEY,
  composition_id INTEGER NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- What happens in this scene, as prose: the storyboard's caption.
  description TEXT,
  -- How long it runs, when the piece is timed. Null for "as long as it
  -- takes" — a drone's scenes rarely have a length.
  duration_seconds REAL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX composition_scenes_composition_idx
  ON composition_scenes (composition_id, position);

-- One part of the piece: a thing that plays, modulates, colours or is
-- ridden across the scenes. The rows of the storyboard.
CREATE TABLE composition_elements (
  id SERIAL PRIMARY KEY,
  composition_id INTEGER NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- voice | rhythm | modulation | effect | texture | control | other
  -- (services/compositions.js is what validates it).
  kind TEXT NOT NULL DEFAULT 'voice',
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX composition_elements_composition_idx
  ON composition_elements (composition_id, position);

-- What one element does in one scene: the cell of the grid. No row means
-- the element is not playing in that scene.
CREATE TABLE composition_scene_elements (
  id SERIAL PRIMARY KEY,
  scene_id INTEGER NOT NULL REFERENCES composition_scenes(id) ON DELETE CASCADE,
  element_id INTEGER NOT NULL REFERENCES composition_elements(id) ON DELETE CASCADE,
  -- enter | hold | change | exit
  action TEXT NOT NULL DEFAULT 'hold',
  -- How: "open the cutoff over the whole scene", "drop to half volume".
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX composition_scene_elements_element_idx
  ON composition_scene_elements (element_id);

-- A composition performed on a patch. The pair is its own record because a
-- piece can be played on more than one patch, and the way it is played on
-- each has notes of its own.
CREATE TABLE composition_patches (
  id SERIAL PRIMARY KEY,
  composition_id INTEGER NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX composition_patches_patch_idx ON composition_patches (patch_id);

-- What realises one element in one patch: exactly one of an instance
-- (patch_module_id alone), a component of an instance (patch_module_id +
-- component_id), a bus (group_id) or a cable (cable_id). Soft references
-- into the patch's own tables, with the name the target had when it was
-- chosen kept beside them, so a mapping outlives the row it points at and
-- says what it pointed at.
CREATE TABLE composition_mappings (
  id SERIAL PRIMARY KEY,
  composition_patch_id INTEGER NOT NULL REFERENCES composition_patches(id) ON DELETE CASCADE,
  element_id INTEGER NOT NULL REFERENCES composition_elements(id) ON DELETE CASCADE,
  patch_module_id INTEGER,
  component_id INTEGER,
  group_id INTEGER,
  cable_id INTEGER,
  target_label TEXT NOT NULL,
  -- Why this target, or how it is played: "ride the cutoff, never below 9".
  note TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT composition_mappings_one_target CHECK (
    (CASE WHEN patch_module_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN group_id IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN cable_id IS NULL THEN 0 ELSE 1 END) = 1
  ),
  -- A component is only ever named as a component OF an instance.
  CONSTRAINT composition_mappings_component_on_instance CHECK (
    (CASE WHEN component_id IS NOT NULL AND patch_module_id IS NULL THEN 1 ELSE 0 END) = 0
  )
);

CREATE INDEX composition_mappings_realization_idx
  ON composition_mappings (composition_patch_id, position);
CREATE INDEX composition_mappings_element_idx ON composition_mappings (element_id);
`;
  // One composition name per account, the rule patches follow (035).
  await createIndex('compositions_user_name_uniq', 'compositions', ['user_id', 'name'], {
    unique: true,
  });
  // One cell per (scene, element); one realisation per (composition, patch).
  await createIndex(
    'composition_scene_elements_cell_uniq',
    'composition_scene_elements',
    ['scene_id', 'element_id'],
    { unique: true }
  );
  await createIndex(
    'composition_patches_pair_uniq',
    'composition_patches',
    ['composition_id', 'patch_id'],
    { unique: true }
  );
}

export async function down({ dropTable }) {
  await dropTable(
    'composition_mappings',
    'composition_patches',
    'composition_scene_elements',
    'composition_elements',
    'composition_scenes',
    'compositions'
  );
}
