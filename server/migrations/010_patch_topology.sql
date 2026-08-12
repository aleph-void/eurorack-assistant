-- Everything a patch needs to describe itself that a flat list of cables
-- against a rack snapshot could not.
--
-- 1. INSTANCE LABELS AND GROUPS. A rack with two LXRs and five Batumis is
--    unreadable as "instance 1 / instance 2": patch notes name them by role
--    ("LXR #1 — snare", "Levit8 #2 — melodic bus") and organise them into
--    buses or layers ("Layer 1: Rhythm", "Granular bus"). label names one
--    instance, patch_groups names a set of them.
CREATE TABLE patch_groups (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_groups_patch_idx ON patch_groups (patch_id);

ALTER TABLE patch_modules ADD COLUMN label TEXT;
-- Soft reference (like every other id on the patch tables): a deleted group
-- simply leaves its members ungrouped.
ALTER TABLE patch_modules ADD COLUMN group_id INTEGER;

-- 2. THINGS IN THE PATCH THAT ARE NOT MODULES IN THE RACK. A patch routinely
--    reaches outside the snapshot:
--      - off-rack gear at the end (or start) of a signal path: a computer and
--        its DAW behind an Expert Sleepers ES-9, the MIDI interface driving
--        Conway's Game, the monitors and PA everything ends up in, a mixing
--        desk, a guitar pedal in an effects loop;
--      - modules the patch calls for that the rack does not hold (a borrowed
--        Doepfer A-140, "or a Tiptop VCA").
--    Both are patch_modules rows with no live module behind them: external =
--    true marks off-rack gear, and either kind declares its own connection
--    points in patch_module_ports (there is no analyzed component list to
--    draw on). Cables address those ports exactly like components — the
--    patch_module at each end says which namespace the id belongs to.
ALTER TABLE patch_modules ADD COLUMN external BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE patch_module_ports (
  id SERIAL PRIMARY KEY,
  patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- 'input_jack' | 'output_jack' | 'bidirectional_jack', matching the
  -- component types so the cable rules and the tracers need no special case.
  type TEXT NOT NULL DEFAULT 'input_jack',
  -- NULL for an ordinary 3.5mm patch point; otherwise 'midi_din', 'usb', ...
  port_kind TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_module_ports_module_idx ON patch_module_ports (patch_module_id);

-- 3. INSTANCES WIRED TO EACH OTHER WITHOUT PATCH CABLES.
--      kind 'expander' — a host instance and its expander instance (see
--        module_expanders): the pair behaves as one module, so a route
--        declared on the host may end at a jack on the expander's panel.
--      kind 'bridge'   — a pair of modules that carries signals between two
--        points of a system over a single non-patch connection. Omnitone
--        7Path is exactly this: two passive panels joined by an ethernet
--        cable where jack N on one appears at jack N on the other, and each
--        pair's direction is decided by which side a cable is plugged into.
CREATE TABLE patch_module_links (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  a_patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  b_patch_module_id INTEGER NOT NULL REFERENCES patch_modules(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'expander',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_module_links_patch_idx ON patch_module_links (patch_id);

-- Which jack on side A carries the same signal as which jack on side B.
-- Only bridges need these rows (an expander's connections are declared once
-- on the module, as routes and normalizations).
CREATE TABLE patch_module_link_jacks (
  id SERIAL PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES patch_module_links(id) ON DELETE CASCADE,
  a_component_id INTEGER,
  a_component_name TEXT NOT NULL,
  b_component_id INTEGER,
  b_component_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_module_link_jacks_link_idx ON patch_module_link_jacks (link_id);

-- 4. WHAT A CABLE IS, BEYOND ITS TWO ENDS. Patch notes are full of cables
--    that are provisional ("add the distortion layer later"), alternatives
--    ("HexVCA or a Tiptop VCA"), physically stacked (one output feeding many
--    inputs through stackcables or a passive mult) or simply need a word of
--    explanation.
ALTER TABLE patch_cables ADD COLUMN note TEXT;
ALTER TABLE patch_cables ADD COLUMN optional BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patch_cables ADD COLUMN stacked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patch_cables ADD COLUMN alt_group TEXT;
