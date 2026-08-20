-- How big the system's floor plan is, in the same units the rack coordinates
-- are in: HP across and rack units down. A studio that stands in one long
-- row needs a plan far wider than the default, and the plan cannot be
-- dragged into space that is not there — so the size is the user's to set.
-- The defaults are the extent the plan used to assume.
ALTER TABLE systems ADD COLUMN floor_width REAL NOT NULL DEFAULT 140;
ALTER TABLE systems ADD COLUMN floor_height REAL NOT NULL DEFAULT 9;
