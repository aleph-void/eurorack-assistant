-- Internal signal paths through a module: an input jack whose signal
-- (possibly processed) appears at an output jack. A mixer routes each channel
-- input to the mix output (a merge), a filter routes its audio input to every
-- filter output (a split), a VCA routes its signal input to its output.
-- Control inputs that only modulate (pitch CV, cutoff CV) are NOT routes —
-- the signal itself does not pass through them.
--
-- These rows are what lets a patch trace signal flow ACROSS a module instead
-- of stopping at its panel: cable in → route → out → next cable. An output
-- jack that no route feeds is treated as a signal GENERATOR (oscillator,
-- noise, LFO, envelope outputs) — the starting point of a flow.
--
-- Extracted from the manual during analysis (rewritten on re-analysis) and
-- user-editable like components, values and normalizations.
CREATE TABLE component_routes (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  input_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  output_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_routes_module_idx ON component_routes (module_id);
