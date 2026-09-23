// Patching by the model.
//
//   generate_patch — wire up a patch the user made empty, within the cable
//                    budget and to the brief they gave (services/patchGenerator.js)
//   patch_turn     — answer a cable the user plugged with one of the model's
//                    own, in collaboration mode (services/patchTurn.js)
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js. A
// handler that answers with a line of text has that line said in the job's
// completion event — the toast that announces a finished job.

import { generatePatch, readMaxCables } from '../../services/patchGenerator.js';
import { takePatchTurn } from '../../services/patchTurn.js';

export function createPatchesHandlers(db) {
  // The patch a job names, its owner's alone. A patch deleted while the job
  // waited is not coming back — nor is a retry going to find it.
  async function ownedPatch(job, payload) {
    const patch = await db.models.Patch.findOne({
      where: { id: Number(payload.patch_id) || 0, user_id: job.user_id },
    });
    if (!patch) {
      const gone = new Error(`Patch ${payload.patch_id} no longer exists`);
      gone.permanent = true;
      throw gone;
    }
    return patch;
  }

  async function handleGeneratePatch(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    const patch = await ownedPatch(job, payload);
    const chosen = Array.isArray(payload.patch_module_ids)
      ? payload.patch_module_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const { cables, settings, refused, reachesOutput } = await generatePatch(db, backend, patch, {
      maxCables: readMaxCables(payload.max_cables).value,
      brief: String(payload.prompt || ''),
      focus: chosen.length > 0 ? { patchModuleIds: chosen, only: Boolean(payload.only_modules) } : null,
      log: progress,
    });
    progress(
      `patched ${cables} cable(s) and dialed in ${settings} setting(s) on '${patch.name}'` +
        (refused > 0 ? ` (${refused} proposal(s) broke the cable rules and were left out)` : '') +
        (reachesOutput === false ? ' — audio reaches no output yet' : '')
    );
  }

  // One move of the model's. The mode may have been switched off while the
  // job waited on the queue: then the user has said they want the next
  // cable to be theirs, and the turn is not taken.
  async function handlePatchTurn(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    const patch = await ownedPatch(job, payload);
    if (!patch.collaborating) {
      const off = 'collaboration was switched off before the model took its turn';
      progress(off);
      return off;
    }
    const { text, note, settings } = await takePatchTurn(db, backend, patch, {
      brief: String(payload.prompt || ''),
      cableId: Number(payload.cable_id) || null,
      log: progress,
    });
    const said =
      `plugged ${text}` +
      (note ? ` — ${note}` : '') +
      (settings > 0 ? ` (and set ${settings} control(s) for it)` : '');
    progress(said);
    return said;
  }

  return {
    generate_patch: handleGeneratePatch,
    patch_turn: handlePatchTurn,
  };
}
