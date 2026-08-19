-- A system is a collection of racks that are patched together as one
-- instrument: the studio, the live case plus its skiff, the desk. Racks stay
-- the unit of inventory and physical layout; a system says which of them sit
-- side by side and may be cabled to each other.
CREATE TABLE systems (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The systems list is read per user and ordered by name.
CREATE INDEX systems_user_idx ON systems (user_id, name);

-- A rack belongs to at most one system, and sits somewhere on that system's
-- floor plan. Dropping a system leaves its racks intact and unassigned —
-- racks own the modules, systems only group them.
ALTER TABLE racks ADD COLUMN system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;
-- Where the rack stands in the system's studio layout. Coordinates are HP
-- across and rack-units down, so a rack's own row geometry sizes the box the
-- user drags; position breaks ties into a stable order.
ALTER TABLE racks ADD COLUMN system_x REAL NOT NULL DEFAULT 0;
ALTER TABLE racks ADD COLUMN system_y REAL NOT NULL DEFAULT 0;
ALTER TABLE racks ADD COLUMN system_position INTEGER NOT NULL DEFAULT 0;

-- Reading a system means reading its racks in layout order.
CREATE INDEX racks_system_idx ON racks (system_id, system_position);

-- A patch built from a system spans every rack in it. Like rack_id above it,
-- these are SOFT references (no FK): the patch keeps rendering after the
-- system is renamed, broken up or deleted, and the name column takes over.
ALTER TABLE patches ADD COLUMN system_id INTEGER;
ALTER TABLE patches ADD COLUMN system_name TEXT;

-- Which rack each snapshotted instance came from, so a multi-rack patch can
-- group its instances by rack and match them to the right rack's physical
-- rows. Soft references for the same reason.
ALTER TABLE patch_modules ADD COLUMN rack_id INTEGER;
ALTER TABLE patch_modules ADD COLUMN rack_name TEXT;

-- Racks have always been read per user and ordered by name (the rack list,
-- the module-visibility joins), and the systems page now also asks for a
-- user's unassigned racks. Until now every one of those was a full scan over
-- everybody's racks.
CREATE INDEX racks_user_idx ON racks (user_id, name);
