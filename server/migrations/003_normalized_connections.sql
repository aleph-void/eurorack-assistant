-- Normalized (normalled) connections between a module's components, extracted
-- from the manual during analysis. A normalization is a default connection
-- that exists only while nothing is patched into the target input:
--   - kind 'input':    the target input is normalled to another INPUT jack —
--                      the signal patched into the source input also feeds the
--                      target (e.g. the Levit8 normals inputs 2-4 to input 1).
--   - kind 'output':   the target input receives the signal of an OUTPUT jack
--                      on the same module (e.g. an oscillator output normalled
--                      to the filter's audio input).
--   - kind 'internal': the target input receives an internal signal that has
--                      no panel component; source_label names it.
-- Tracking these makes it possible to trace the actual signal path through a
-- patch, including connections no cable represents.
CREATE TABLE component_normalizations (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- The component receiving the normalled signal (an input jack).
  target_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  -- Where the signal comes from: a panel component, or NULL with source_label
  -- describing an internal source (or a source name the analysis could not
  -- match to a component).
  source_component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE,
  source_label TEXT,
  kind TEXT NOT NULL DEFAULT 'internal',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_normalizations_module_idx ON component_normalizations (module_id);
