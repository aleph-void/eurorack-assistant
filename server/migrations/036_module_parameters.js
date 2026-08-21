// Menu parameters: the settings a module holds behind an encoder and a
// display rather than under a knob of its own.
//
// The component inventory answers "what is on the panel", and component_values
// answers "what positions does this control have" — between them they cover a
// filter whose LP/BP/HP switch you can see. They do not cover ALC's Pamela's
// Pro Workout, whose eight outputs are configured entirely through one
// encoder: each output has its own clock division, waveform, level, pulse
// width, euclidean pattern and a dozen more, and none of them is a thing on
// the panel that could be given a marker or a position. A patch of such a
// module records nothing today — patch_settings takes one value per
// component, and jacks are refused outright.
//
// So a PARAMETER is its own hardware fact, hanging off the module and
// (usually) off the jack or control it configures, with its own list of
// options; a patch_settings row grows a soft reference to one, which is what
// lets an output jack carry a dozen recorded values while a knob still
// carries exactly one.

export const description = 'menu parameters behind a module encoder, and the patch values recorded for them';

export async function up({ sql }) {
  await sql`
CREATE TABLE module_parameters (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- The panel thing this parameter configures: usually an output jack (an
  -- output's clock division), sometimes the encoder or button that reaches
  -- the menu. NULL is a parameter of the WHOLE module — a global tempo, a
  -- sync source.
  component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- The menu page or bank the manual lists it under, for grouping in the UI.
  group_label TEXT,
  -- 'enum' (pick one of the options), 'number' (a range), 'text' (anything).
  value_type TEXT NOT NULL DEFAULT 'enum',
  unit TEXT,
  value_min TEXT,
  value_max TEXT,
  default_value TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX module_parameters_module_idx ON module_parameters (module_id);
CREATE INDEX module_parameters_component_idx ON module_parameters (component_id);

-- One row per selectable setting of an 'enum' parameter, in menu order. This
-- is what turns "output 1 division" into a list to pick from rather than a
-- box to type a guess into.
CREATE TABLE module_parameter_options (
  id SERIAL PRIMARY KEY,
  parameter_id INTEGER NOT NULL REFERENCES module_parameters(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX module_parameter_options_parameter_idx ON module_parameter_options (parameter_id);
`;
  // Soft, like every other module reference a patch keeps: the parameter may
  // be re-analyzed away or renamed and the patch still says what was dialed
  // in. parameter_name is the snapshot that survives it.
  // A module-wide parameter (a global tempo) sits on no component at all, so
  // the component name a setting snapshots stops being compulsory.
  await sql`
ALTER TABLE patch_settings ADD COLUMN parameter_id INTEGER;
ALTER TABLE patch_settings ADD COLUMN parameter_name TEXT;
ALTER TABLE patch_settings ALTER COLUMN component_name DROP NOT NULL;
`;
}

export async function down({ sql, dropColumn, dropTable }) {
  // The rows with no component are exactly the module-wide parameter values,
  // which mean nothing once parameter_id is gone — and nothing else can hold
  // the NULL that would refuse the constraint back.
  await sql`
DELETE FROM patch_settings WHERE component_name IS NULL;
ALTER TABLE patch_settings ALTER COLUMN component_name SET NOT NULL;
`;
  await dropColumn('patch_settings', 'parameter_id', 'parameter_name');
  await dropTable('module_parameter_options', 'module_parameters');
}
