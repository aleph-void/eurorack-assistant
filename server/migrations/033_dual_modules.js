// DUAL MODULES. Some products are one instrument sold as TWO panels that are
// joined by a link cable rather than by patch cables — Omnitone 7Path's pair,
// joined by an ethernet lead. Unlike an expander (migration 009), neither
// panel is the host: each numbered jack on one panel is wired to the jack of
// the same number on the other, and those jacks are bidirectional. Whichever
// end a cable is patched INTO is that wire's input, and the matching jack on
// the OPPOSITE panel is where the signal comes out.
//
// A patch could already record such a pair — patch_module_links kind
// 'bridge', migration 010 — but only by being told about it patch by patch.
// module_bridges states the fact once, on the hardware, so every patch built
// from the rack wires the pair up the way the ethernet cable already has.
//
// The two halves may be the SAME module record: a 7Path pair is imported as
// one module with quantity 2, so a bridge whose a_module_id equals its
// b_module_id says "two instances of this module ARE the two halves". That is
// why this is not a `kind` column on module_expanders, whose two sides are a
// host and its expander and may never be the same module.
//
// module_bridge_jacks is the exception rather than the rule: two panels of one
// product almost always carry the same jack labels, so a pair with no rows
// pairs its jacks BY NAME. Rows are only needed when the two panels label the
// same wire differently. They hang off module_components, so re-analyzing a
// panel (which renumbers its components) drops them and the pair falls back to
// pairing by name — the same place a freshly declared pair starts from.

export const description = 'dual modules: two panels joined by a link cable';

export async function up({ sql }) {
  await sql`
CREATE TABLE module_bridges (
  id SERIAL PRIMARY KEY,
  a_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  b_module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX module_bridges_pair_idx ON module_bridges (a_module_id, b_module_id);
CREATE INDEX module_bridges_b_idx ON module_bridges (b_module_id);

CREATE TABLE module_bridge_jacks (
  id SERIAL PRIMARY KEY,
  bridge_id INTEGER NOT NULL REFERENCES module_bridges(id) ON DELETE CASCADE,
  a_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  b_component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE
);

CREATE INDEX module_bridge_jacks_bridge_idx ON module_bridge_jacks (bridge_id);
`;
}

export async function down({ dropTable }) {
  await dropTable('module_bridge_jacks', 'module_bridges');
}
