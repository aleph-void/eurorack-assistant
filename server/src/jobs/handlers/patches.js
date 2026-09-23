// Patching by the model.
//
//   generate_patch — wire up a patch the user made empty, within the cable
//                    budget and to the brief they gave (services/patchGenerator.js)
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js.

import { generatePatch, readMaxCables } from '../../services/patchGenerator.js';

export function createPatchesHandlers(db) {
  async function handleGeneratePatch(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    // The patch is its owner's alone, and a patch deleted while the job
    // waited is not coming back — nor is a retry going to find it.
    const patch = await db.models.Patch.findOne({
      where: { id: Number(payload.patch_id) || 0, user_id: job.user_id },
    });
    if (!patch) {
      const gone = new Error(`Patch ${payload.patch_id} no longer exists`);
      gone.permanent = true;
      throw gone;
    }
    const { cables, settings, refused } = await generatePatch(db, backend, patch, {
      maxCables: readMaxCables(payload.max_cables).value,
      brief: String(payload.prompt || ''),
      log: progress,
    });
    progress(
      `patched ${cables} cable(s) and dialed in ${settings} setting(s) on '${patch.name}'` +
        (refused > 0 ? ` (${refused} proposal(s) broke the cable rules and were left out)` : '')
    );
  }

  return {
    generate_patch: handleGeneratePatch,
  };
}
