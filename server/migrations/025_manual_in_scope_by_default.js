// The manual proper joins the analysis-scope flag it gave everything else.
//
// Migration 024 made "submitted with the analysis" an explicit per-document
// flag, but the manual itself stayed outside it: the analyze jobs always
// submitted the manual no matter what the flag said, so its checkbox showed
// unchecked and did nothing. Now the manual arrives marked in scope like the
// vendor pages do, and unmarking it genuinely leaves it out of the next
// analysis. Existing shared manuals start marked to carry the old
// always-submitted behavior over; companion documents (recognized by the
// same name patterns migration 024 used) keep whatever the user chose.

export const description = 'the manual itself starts in analysis scope';

export async function up({ sql }) {
  await sql`
UPDATE manuals SET analysis_scope = TRUE
WHERE user_id IS NULL
  AND (original_name IS NULL OR (
        lower(original_name) NOT LIKE '%_perfect_circuit_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_detroit_modular_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_midwest_modular_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_build_document.pdf'
  ));
`;
}

export async function down({ sql }) {
  // Unmark exactly the rows the up marked. Migration 024 only ever marked
  // companion documents, which this predicate excludes, so the only rows this
  // clears that were not set here are ones a user marked themselves in the
  // window between the two migrations.
  await sql`
UPDATE manuals SET analysis_scope = FALSE
WHERE user_id IS NULL
  AND (original_name IS NULL OR (
        lower(original_name) NOT LIKE '%_perfect_circuit_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_detroit_modular_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_midwest_modular_product_page.pdf'
    AND lower(original_name) NOT LIKE '%_build_document.pdf'
  ));
`;
}
