-- How wide the module is, as a property of the module itself.
--
-- HP was only ever recorded on module_panels (migration 016), where it is a
-- by-product of drawing the panel: the width the LLM read out of the manual,
-- or the one the research step happened to notice on a product page. That
-- makes it invisible until a panel exists, and it disappears when the panel is
-- rebuilt from a different source. A module's width is a fact about the
-- module — it is what decides whether the thing fits the empty space in the
-- rack — so it belongs on the module record, where the import can write it
-- straight from a ModularGrid rack (which states it for every module) or from
-- an 'hp' column in a pasted CSV.
--
-- module_panels.hp stays: it is the width the panel picture was DRAWN at, and
-- the two can legitimately differ (an image found on the web is whatever size
-- it is). The panel job fills this column in when the module has no width yet.
ALTER TABLE modules ADD COLUMN hp REAL;

-- Existing databases already know some widths from their panels.
UPDATE modules
   SET hp = p.hp
  FROM module_panels p
 WHERE p.module_id = modules.id
   AND p.hp IS NOT NULL
   AND modules.hp IS NULL;

-- Panels a user supplied themselves. module_panels.source has always been
-- 'image' (found on the web) or 'generated' (drawn from the manual); 'upload'
-- is the third, and it outranks both: a picture someone deliberately chose is
-- better than anything the research step can find, so the panel job never
-- replaces it — it re-locates the components on the uploaded image instead
-- (see services/panelImage.js).
COMMENT ON COLUMN module_panels.source IS
  'image (found on the web), generated (drawn from the manual), or upload (supplied by a user)';
