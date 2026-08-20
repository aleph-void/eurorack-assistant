// Indexes the schema had been getting by without.
//
// Postgres indexes primary keys and unique constraints and nothing else: a
// foreign key column is a sequential scan until somebody says otherwise. That
// is fine while a table is small, and these tables stop being small in three
// places — the module catalogue everybody shares, the job queue, and the link
// tables between them.
//
// Three kinds of index are added here, and they are worth different things:
//
//   1. Lookups a page cannot render without. These are the ones that show up
//      as latency.
//   2. The other half of a composite primary key. PRIMARY KEY (a, b) indexes
//      (a) and (a, b), so every one of these link tables could be read from
//      one end and only scanned from the other.
//   3. The referencing side of a cascade. Deleting a parent row makes postgres
//      check every child table for orphans; with no index that check is a scan
//      per deleted row. Re-analyzing one module deletes all of its components,
//      and a dozen tables reference module_components.
//
// Ordering columns are left ascending even where the query sorts descending:
// postgres reads a btree backwards just as happily, and a DESC index would buy
// nothing here.
//
// ---------------------------------------------------------------------------
// 1. Lookups on the read paths
// ---------------------------------------------------------------------------
//
// Every module page, every analysis, every patch load: "the components of this
// module". The single most-run query in the app with nothing behind it.

export const description = 'indexes, round one';

export async function up({ sql }) {
  await sql`
CREATE INDEX module_components_module_idx ON module_components (module_id);

-- "Does this user have this module?" — asked before every note and question
-- attachment, and again for every module page. rack_modules is keyed
-- (rack_id, module_id), so the module_id end was the scan.
CREATE INDEX rack_modules_module_idx ON rack_modules (module_id);

-- The notes and questions lists, in the order they are shown.
CREATE INDEX notes_user_updated_idx ON notes (user_id, updated_at, id);
CREATE INDEX questions_user_created_idx ON questions (user_id, created_at, id);

-- The jobs page, which the browser polls, and the dedupe the worker runs
-- before queueing anything: "is a job of this type already live for this
-- module?" — once per module on every import.
CREATE INDEX jobs_user_idx ON jobs (user_id, id);
CREATE INDEX jobs_module_type_idx ON jobs (module_id, type, status);
CREATE INDEX jobs_question_idx ON jobs (question_id);

-- Captures hang off a note, and are read back every time the note is.
CREATE INDEX captures_note_idx ON captures (note_id);

-- Logging a user out everywhere, and cascading their sessions when the
-- account goes.
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- manuals (user_id) is deliberately NOT indexed, and this is the note for
-- whoever notices the gap and reaches for it.
--
-- "user_id IS NULL" is how the whole app asks for the shared auto-found manual
-- as opposed to somebody's upload, and pg-mem — the in-memory postgres the
-- tests run against — answers that wrongly once the column is indexed: with an
-- index in place, "module_id = $1 AND user_id IS NULL AND hash = $2" returns
-- nothing at all for a row that is right there. Real postgres has no such
-- problem (a btree indexes NULLs and answers IS NULL from them), so the index
-- would be correct in production and would silently break the test suite,
-- which is not a trade worth making for what it buys: the reads that matter
-- are already served by manuals_module_name_hash_uidx, and what is left is the
-- cascade when an account is deleted.

-- ---------------------------------------------------------------------------
-- 2. The far end of the link tables
-- ---------------------------------------------------------------------------

-- Read from the module/component/patch side: "which notes are attached to this
-- module", "which questions cite this component", "which notes belong to this
-- patch". Each is also the cascade path when that parent is deleted.
CREATE INDEX note_modules_module_idx ON note_modules (module_id);
CREATE INDEX note_components_component_idx ON note_components (component_id);
CREATE INDEX note_patches_patch_idx ON note_patches (patch_id);
CREATE INDEX question_modules_module_idx ON question_modules (module_id);
CREATE INDEX question_components_component_idx ON question_components (component_id);
CREATE INDEX question_manuals_manual_idx ON question_manuals (manual_id);
CREATE INDEX question_notes_note_idx ON question_notes (note_id);
CREATE INDEX question_captures_capture_idx ON question_captures (capture_id);
-- A question cited as a source by other questions, when it is deleted.
CREATE INDEX question_answers_source_idx ON question_answers (source_question_id);
CREATE INDEX component_switch_steps_component_idx ON component_switch_steps (component_id);

-- ---------------------------------------------------------------------------
-- 3. What points at a component, for when components are replaced
-- ---------------------------------------------------------------------------

-- analyze_manual rewrites a module's components wholesale — DELETE every row,
-- then insert the new ones — and each of these tables references the rows
-- going away. Without an index that is one scan per table per deleted
-- component; the module catalogue is shared, so these tables hold every user's
-- modules at once.
CREATE INDEX component_normalizations_target_idx ON component_normalizations (target_component_id);
CREATE INDEX component_normalizations_source_idx ON component_normalizations (source_component_id);
CREATE INDEX component_normalizations_condition_idx
  ON component_normalizations (condition_component_id);
CREATE INDEX component_normalizations_break_idx ON component_normalizations (break_component_id);
CREATE INDEX component_routes_input_idx ON component_routes (input_component_id);
CREATE INDEX component_routes_output_idx ON component_routes (output_component_id);
CREATE INDEX component_routes_condition_idx ON component_routes (condition_component_id);
CREATE INDEX component_switches_common_idx ON component_switches (common_component_id);
CREATE INDEX component_pairs_a_idx ON component_pairs (a_component_id);
CREATE INDEX component_pairs_b_idx ON component_pairs (b_component_id);

-- The same shape one level down: removing one instance from a patch cascades
-- into its cables, settings and links.
CREATE INDEX patch_cables_from_idx ON patch_cables (from_patch_module_id);
CREATE INDEX patch_cables_to_idx ON patch_cables (to_patch_module_id);
CREATE INDEX patch_settings_module_idx ON patch_settings (patch_module_id);
CREATE INDEX patch_module_links_a_idx ON patch_module_links (a_patch_module_id);
CREATE INDEX patch_module_links_b_idx ON patch_module_links (b_patch_module_id);

-- Revoking a device token, and deleting a user with grants in flight.
CREATE INDEX captures_device_token_idx ON captures (device_token_id);
CREATE INDEX device_authorizations_user_idx ON device_authorizations (user_id);
`;
}

export async function down({ dropIndex }) {
  await dropIndex(
    'module_components_module_idx',
    'rack_modules_module_idx',
    'notes_user_updated_idx',
    'questions_user_created_idx',
    'jobs_user_idx',
    'jobs_module_type_idx',
    'jobs_question_idx',
    'captures_note_idx',
    'sessions_user_idx',
    'note_modules_module_idx',
    'note_components_component_idx',
    'note_patches_patch_idx',
    'question_modules_module_idx',
    'question_components_component_idx',
    'question_manuals_manual_idx',
    'question_notes_note_idx',
    'question_captures_capture_idx',
    'question_answers_source_idx',
    'component_switch_steps_component_idx',
    'component_normalizations_target_idx',
    'component_normalizations_source_idx',
    'component_normalizations_condition_idx',
    'component_normalizations_break_idx',
    'component_routes_input_idx',
    'component_routes_output_idx',
    'component_routes_condition_idx',
    'component_switches_common_idx',
    'component_pairs_a_idx',
    'component_pairs_b_idx',
    'patch_cables_from_idx',
    'patch_cables_to_idx',
    'patch_settings_module_idx',
    'patch_module_links_a_idx',
    'patch_module_links_b_idx',
    'captures_device_token_idx',
    'device_authorizations_user_idx'
  );
}
