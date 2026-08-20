// Which documents ride along when a module's components are (re)analyzed.
//
// Until now the analyze jobs picked companions by recognizing vendor-page
// file names (Perfect Circuit / Detroit Modular / Midwest Modular renders,
// build documents). The flag makes that an explicit, user-editable property
// of the document instead: the analysis submits the manual proper plus every
// document marked in scope. Vendor pages the finder saves are marked
// automatically; users mark (or unmark) anything else from the module page.

export const description = 'which documents ride along with an analysis';

export async function up({ sql }) {
  await sql`
ALTER TABLE manuals ADD COLUMN analysis_scope BOOLEAN NOT NULL DEFAULT FALSE;

-- Carry the old behavior over: every saved vendor page and build document
-- was always submitted alongside the manual, so they start marked. (In LIKE
-- patterns \`_\` matches any one character, which matches the literal
-- underscore these names use.)
UPDATE manuals SET analysis_scope = TRUE
WHERE lower(original_name) LIKE '%_perfect_circuit_product_page.pdf'
   OR lower(original_name) LIKE '%_detroit_modular_product_page.pdf'
   OR lower(original_name) LIKE '%_midwest_modular_product_page.pdf'
   OR lower(original_name) LIKE '%_build_document.pdf';
`;
}

export async function down({ dropColumn }) {
  // The flags this migration set go with the column that holds them.
  await dropColumn('manuals', 'analysis_scope');
}
