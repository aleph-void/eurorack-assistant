-- Two facts about hardware that a single flat module record cannot express.
--
-- 1. EXPANDERS. Some modules are one instrument in two panels, joined by a
--    ribbon cable rather than patch cables: Intellijel Atlantix + Atlx (the
--    expander's 16 jacks are wired straight to the host's oscillators, filter
--    and ring modulator), Humble Audio Quad Operator + Algo, Bohm + Groove /
--    Performer, Instruo Arbhar + its CV expansion, ALM Pam's + PEXP.
--    module_expanders declares the relationship, which lets a route or a
--    normalization on the HOST reference a component that lives on the
--    EXPANDER, so signal can be traced across the pair.
CREATE TABLE module_expanders (
  id SERIAL PRIMARY KEY,
  host_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  expander_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX module_expanders_pair_idx ON module_expanders (host_module_id, expander_module_id);
CREATE INDEX module_expanders_expander_idx ON module_expanders (expander_module_id);

-- 2. PORTS THAT ARE NOT 3.5MM JACKS. A module's connections to the world are
--    not all eurorack patch points: MIDI DIN and 3.5mm-TRS MIDI (Erica Drum
--    Sequencer, Nervous Squirrel Conway's Game), USB (Expert Sleepers ES-9,
--    Intellijel Metropolix), S/PDIF and ADAT, 1/4" and RCA audio, built-in
--    microphones (Instruo Arbhar, Qu-Bit Mojave), ethernet (Omnitone 7Path),
--    memory cards. These are still inputs and outputs — they carry signal and
--    belong in the flow graph — so they keep their input_jack / output_jack /
--    bidirectional_jack type and gain a port_kind saying what the physical
--    connector is. NULL means an ordinary eurorack 3.5mm patch point.
--
--    Cables may only join ports of the same kind, which is what stops a CV
--    output being patched into a MIDI socket.
ALTER TABLE module_components ADD COLUMN port_kind TEXT;
