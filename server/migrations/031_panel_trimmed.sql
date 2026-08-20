-- Trim now cuts the blank backdrop out of the panel FILE rather than only
-- recording where the front plate sits, so the picture on its own is the
-- panel. Trimming works by peeling uniform lines off the edges, which is
-- exactly what an already-trimmed plate's own border looks like — pressing
-- Trim twice would eat into the hardware. This says the file has already
-- been cut down, so a second press is a no-op instead. A panel replaced by
-- research, a redraw or an upload starts as a fresh row, untrimmed.
ALTER TABLE module_panels ADD COLUMN trimmed BOOLEAN NOT NULL DEFAULT FALSE;
