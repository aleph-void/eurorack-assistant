-- Mult support. Passive mults (and similar modules) have interchangeable
-- jacks: any one of them can take the input, and the rest become output
-- copies of it. Such jacks get component type 'bidirectional_jack', and
-- group_label names the mult section they belong to on modules with several
-- (e.g. a 2x2 mult has groups '1' and '2'; ungrouped bidirectional jacks on a
-- module count as one group). A patch decides each jack's role by how it is
-- cabled: a cable INTO the jack makes it the group's input (one per group),
-- cables OUT of the others carry the copies.
ALTER TABLE module_components ADD COLUMN group_label TEXT;
