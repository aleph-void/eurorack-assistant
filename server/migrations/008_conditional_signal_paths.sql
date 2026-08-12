-- Conditional signal paths. A module's internal routes and normalled
-- connections are not always unconditional facts: on many modules a panel
-- switch, a stepped knob, a rear jumper or a firmware setting decides which
-- of several paths is live.
--
--   Intellijel Atlantix  the PWM Source switch picks WHICH of two signals is
--                        normalled to PWM IN (VCO B sine, or the envelope);
--                        the AUX 2 ROUTING switch picks WHERE in the chain
--                        the AUX 2 input is inserted (pre-VCF or at the VCA).
--   Erogenous Tones      the CHANNEL 4 / CHANNEL 8 MIX switches turn OUT 4
--   Levit8               and OUT 8 from pass-throughs into 4- and 8-channel
--                        mix outputs.
--   Intellijel Plog      a rear jumper connects logic B's output to the
--                        toggle flip-flop's normalled input.
--
-- Two columns model this:
--   condition_component_id / condition_value — the row is only live while
--     that control is set to that value. A patch records control positions in
--     patch_settings, so the tracer can tell which paths are actually live;
--     with no setting recorded the path is 'possible but unselected'.
--   alt_group — rows sharing a group label (per module) are ALTERNATIVES:
--     at most one is live at a time. This is what stops two switch-selected
--     normals into the same input from rendering as a signal MERGE (two
--     signals summing) when they are really a selection (one at a time).
--
-- A row with neither is unconditional, exactly as before.
ALTER TABLE component_routes ADD COLUMN condition_component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE;
ALTER TABLE component_routes ADD COLUMN condition_value TEXT;
ALTER TABLE component_routes ADD COLUMN alt_group TEXT;

ALTER TABLE component_normalizations ADD COLUMN condition_component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE;
ALTER TABLE component_normalizations ADD COLUMN condition_value TEXT;
ALTER TABLE component_normalizations ADD COLUMN alt_group TEXT;
