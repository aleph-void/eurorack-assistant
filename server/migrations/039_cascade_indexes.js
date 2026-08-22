// Index tune-up, round three (020 and 027 were the first two), this time for
// the tables the newer hardware facts added.
//
// A RE-ANALYSIS DESTROYS AND RECREATES EVERY ROW OF module_components, and
// every table that hangs off a component is deleted with it. Postgres checks
// each of those foreign keys row by row, so a reference column with no index
// behind it is a full scan of its table PER DELETED COMPONENT. Migration 020
// indexed every such column that existed then — including the `condition`
// columns of component_routes and component_normalizations, which are exactly
// this shape — but the three added since were left bare:
//
//   module_bridge_jacks.a_component_id / .b_component_id  (033)
//   component_mult_groups.condition_component_id          (038)
//
// Measured on a 20k-module database (2,000 bridges of 10 jack pairs, 19k
// switched-mult rows), re-analyzing a hundred modules — 2,000 components
// deleted — spent 4.68 s of its 4.86 s inside those three constraint checks
// alone. With the indexes the same delete takes 0.14 s. Every other cascade
// on the same statement costs under a millisecond, which is what these three
// now cost too.
//
// The last one is a read rather than a cascade. The worker's pause sweep
// (`sweepAccountPauses`, at most once every two seconds per runner) asks
// user_llm_accounts for `WHERE paused_until IS NOT NULL`, which was a scan of
// every account on the instance to find the handful that are really paused.
// PARTIAL, because that is the whole predicate: the index holds only the
// paused accounts, so it stays a page or two however many users there are,
// and an account that is not paused never touches it on write.
//
// NOT HERE, deliberately: manuals.user_id, the one foreign key left in the
// schema with no index behind it. It only costs anything when a user is
// deleted, and pg-mem — which stands in for Postgres in the server tests —
// stops finding rows through `user_id IS NULL` as soon as that column is
// indexed, which is how the app looks up a SHARED manual. A partial index
// excluding the nulls does not help; pg-mem indexes them anyway. It is worth
// less than a green test suite.

export const description = 'indexes for the cascades and sweeps the newer tables added';

export async function up({ sql }) {
  await sql`
CREATE INDEX module_bridge_jacks_a_idx ON module_bridge_jacks (a_component_id);
CREATE INDEX module_bridge_jacks_b_idx ON module_bridge_jacks (b_component_id);
CREATE INDEX component_mult_groups_condition_idx
  ON component_mult_groups (condition_component_id);
CREATE INDEX user_llm_accounts_paused_idx
  ON user_llm_accounts (paused_until) WHERE paused_until IS NOT NULL;
`;
}

export async function down({ dropIndex }) {
  await dropIndex(
    'user_llm_accounts_paused_idx',
    'component_mult_groups_condition_idx',
    'module_bridge_jacks_b_idx',
    'module_bridge_jacks_a_idx'
  );
}
