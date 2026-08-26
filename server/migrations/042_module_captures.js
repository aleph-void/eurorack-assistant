// A waveform capture taken on a MODULE's page rather than on a patch.
//
// Migration 013 made a capture a picture filed under a note on the PATCH it
// was taken from, and that is still what a capture on a patch's Scope page
// is. But most scope work is bench work: one module on the rails, a cable
// into the interface, "what does this output actually look like". There is
// no patch for that, and inventing one to hold the picture would put a
// throwaway patch in the library for every measurement.
//
// So a capture may hang off a module instead — the same table, the same
// bytes, the same note, with the note linked to the module (note_modules)
// rather than to a patch. Both columns are nullable and a capture carries at
// most one of them: patch_id for one taken while patching, module_id for one
// taken at the bench. Clips (migration 040) already worked this way round;
// this is the still image catching up.

export const description = 'waveform captures attached to a module';

export async function up({ addColumn, createIndex }) {
  await addColumn(
    'captures',
    'module_id',
    'INTEGER REFERENCES modules(id) ON DELETE CASCADE'
  );
  await createIndex('captures_module_idx', 'captures', 'module_id');
}

export async function down({ dropIndex, dropColumn }) {
  await dropIndex('captures_module_idx');
  await dropColumn('captures', 'module_id');
}
