-- The physical arrangement a patch was built from, kept BY the patch.
--
-- Until now the patch diagram read the rack's rows as they are right now, so
-- reorganising a case rearranged every patch ever made from it. Racks stay
-- the one place modules are organised; what changes here is that a patch
-- takes a copy of that arrangement when it is created and draws from the
-- copy for ever after — with an explicit resync for when a patch should
-- catch up with the case it lives in.
--
-- Soft references throughout, like every other thing a patch snapshots: the
-- rack and the module may be renamed, re-racked or deleted and the patch
-- still draws. Placements name a module rather than a patch instance for the
-- same reason the rest of the snapshot does — the read path matches each
-- placed copy to an instance of the same rack, which is what keeps the two
-- Mathses of a two-rack system at their own ends of the studio.
CREATE TABLE patch_rack_rows (
  id SERIAL PRIMARY KEY,
  patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  rack_id INTEGER,
  rack_name TEXT,
  -- Where this rack stood in the system's order when the patch was made, so
  -- the diagram keeps the studio's left-to-right reading as well as each
  -- case's own rows.
  rack_position INTEGER NOT NULL DEFAULT 0,
  unit INTEGER NOT NULL DEFAULT 3,
  hp REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_rack_rows_patch_idx ON patch_rack_rows (patch_id, position);

CREATE TABLE patch_rack_row_modules (
  id SERIAL PRIMARY KEY,
  row_id INTEGER NOT NULL REFERENCES patch_rack_rows(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patch_rack_row_modules_row_idx ON patch_rack_row_modules (row_id, position);

-- Freeze the patches that already exist to the layout their racks have
-- today. The arrangement they were really built with was never recorded, so
-- today's is the best there is — and it is what those patches are drawing at
-- this moment anyway, which makes this migration invisible rather than a
-- day where every old diagram changes.
--
-- Racks come from the instances (a system patch spans several)...
INSERT INTO patch_rack_rows (patch_id, rack_id, rack_name, rack_position, unit, hp, position)
SELECT DISTINCT pm.patch_id, r.id, r.name, r.system_position, rr.unit, rr.hp, rr.position
FROM patch_modules pm
JOIN racks r ON r.id = pm.rack_id
JOIN rack_rows rr ON rr.rack_id = r.id;

-- ...and for patches made before instances carried a rack, from the patch's
-- own rack. The two selects cannot both fire for one patch: a patch whose
-- instances name no rack at all is exactly what the second one asks for.
INSERT INTO patch_rack_rows (patch_id, rack_id, rack_name, rack_position, unit, hp, position)
SELECT DISTINCT p.id, r.id, r.name, r.system_position, rr.unit, rr.hp, rr.position
FROM patches p
JOIN racks r ON r.id = p.rack_id
JOIN rack_rows rr ON rr.rack_id = r.id
WHERE p.id NOT IN (SELECT patch_id FROM patch_modules WHERE rack_id IS NOT NULL);

-- The placed copies of each row just written. A rack numbers its rows from
-- 0 and never repeats a position, so (rack, position) finds the row each
-- copy came from.
INSERT INTO patch_rack_row_modules (row_id, module_id, position)
SELECT prr.id, rrm.module_id, rrm.position
FROM patch_rack_rows prr
JOIN rack_rows rr ON rr.rack_id = prr.rack_id AND rr.position = prr.position
JOIN rack_row_modules rrm ON rrm.row_id = rr.id;
