// Patching WITH the model, one cable each: the user plugs a cable, the model
// answers with one of its own, and so on until the mode is switched off.
//
// The generator (migration 035's `generate_patch` job) builds a patch in one
// go; this is the same model taking turns instead. Whether a patch is being
// patched that way, and the brief the model is steered by, are facts about
// the PATCH — a cable plugged on the picture, on the cable list or by voice
// is a move whichever page it came from — so they live on its row rather
// than in a browser.

export const description = 'a patch being patched in turns with the model, and its brief';

export async function up({ addColumn, comment }) {
  await addColumn('patches', 'collaborating', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumn('patches', 'collaboration_prompt', 'TEXT');
  await comment(
    'COLUMN patches.collaborating',
    'the model answers every cable the user plugs with one of its own (a patch_turn job)'
  );
  await comment(
    'COLUMN patches.collaboration_prompt',
    'what the patch should become, as told to the model on every turn; NULL for no brief'
  );
}

export async function down({ dropColumn }) {
  await dropColumn('patches', 'collaborating', 'collaboration_prompt');
}
