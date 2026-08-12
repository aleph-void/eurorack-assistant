-- Patch tracking: cable connections between jacks plus per-component settings,
-- captured against a snapshot of a rack at the moment the patch was created.
--
-- Valid values for a module component (knob scale, switch positions, ...),
-- extracted from the manual during analysis and freely editable by users:
--   - type 'min' / 'max': the ends of a continuous range (one row each,
--     value holds the printed scale value, e.g. '0' and '10')
--   - type 'enum':        one row per discrete position (value holds the
--     position label, e.g. 'LP', 'BP', 'HP')
-- The analysis stores four or fewer discrete positions as 'enum' rows and
-- anything continuous (or with more positions) as a 'min'/'max' pair.
CREATE TABLE component_values (
  id SERIAL PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_values_component_idx ON component_values (component_id);

-- A user's patches. A patch belongs to the rack it was created from, but only
-- loosely: rack_id and the module/component references below are plain
-- integers (no FK) on purpose. Modules move between racks, get re-analyzed
-- (which rewrites their components under new ids) or deleted entirely, and
-- the patch must keep rendering as the rack was when the patch was created —
-- so every reference is resolved at read time and the denormalized name
-- columns take over when the referenced row no longer exists.
CREATE TABLE patches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rack_id INTEGER,
  rack_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The rack's contents at patch creation, one row per module INSTANCE (a rack
-- holding quantity 2 of a module yields instance 1 and instance 2, so cables
-- can tell the two apart).
CREATE TABLE patch_modules (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  module_id INTEGER,
  manufacturer TEXT NOT NULL,
  module_name TEXT NOT NULL,
  instance INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_modules_patch_idx ON patch_modules (patch_id);

-- A cable: an output jack on one module instance into an input jack on
-- another (or the same) instance. Component ids are soft references into
-- module_components; the name columns keep the cable meaningful after a
-- re-analysis or module deletion.
CREATE TABLE patch_cables (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  from_patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  from_component_id INTEGER,
  from_component_name TEXT NOT NULL,
  to_patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  to_component_id INTEGER,
  to_component_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_cables_patch_idx ON patch_cables (patch_id);

-- A setting: the position of a knob/slider/switch/... on one module instance
-- in this patch. One row per (instance, component); value is free text and
-- the GUI offers the component's recorded valid values.
CREATE TABLE patch_settings (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  component_id INTEGER,
  component_name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_settings_patch_idx ON patch_settings (patch_id);
