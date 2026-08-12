-- 1. WHAT BREAKS A NORMAL. A normalled connection was modelled as "live
--    until a cable is patched into the target input" — true for the common
--    case, but not for normals between OUTPUTS. Forge TME Vhikk X: "the L
--    output is normalled to the R output, so patching a single cable from R
--    provides a mono sum" — that default is broken by patching a cable OUT of
--    L, not by patching anything INTO R. Erica Synths and Doepfer modules use
--    the same trick to fold individual outputs into a mix.
--
--    break_component_id names the jack whose cable breaks the normal (NULL
--    keeps the old meaning: the target itself), and break_on says which kind
--    of connection breaks it: a cable arriving ('cable_in', the default) or a
--    cable leaving ('cable_out').
ALTER TABLE component_normalizations ADD COLUMN break_component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE;
ALTER TABLE component_normalizations ADD COLUMN break_on TEXT NOT NULL DEFAULT 'cable_in';

-- 2. JACKS THAT BELONG TOGETHER. Stereo runs through the whole format —
--    Make Noise Mimeophon, Qu-Bit Nautilus, Erica Stereo Reverb, Worng
--    Vertex, Vhikk X, Bohm — and a stereo connection is one decision made
--    twice: patch L and R, or you have half a signal. A pair records that two
--    jacks are the two halves of one signal, so a patch can plug both ends in
--    a single step and show them as one connection.
--
--    kind is open ('stereo' for L/R, and e.g. 'sum_difference' or 'quad' for
--    other groupings) but the pair is always two named jacks of one module.
CREATE TABLE component_pairs (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  a_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  b_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'stereo',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX component_pairs_module_idx ON component_pairs (module_id);
