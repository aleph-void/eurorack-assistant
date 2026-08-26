// Helpers shared by the /api/questions sub-routers. Each takes db explicitly
// so the sub-routers stay plain factory functions over it.

import { engagedPatchModuleIds } from '../../services/patchTopology.js';

// Positive integer ids from a client-supplied array, deduped.
export function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// Which modules and components a set of captures is about: the jacks its
// channels were watching, the modules of the patch it was taken on, and —
// for a bench capture — the module it is of.
// Used both to offer captures in the review step and to check that the ones
// submitted belong to the question's scope.
export async function captureLinks(db, captures) {
  const { CaptureChannel, ModuleComponent, PatchModule } = db.models;
  const ids = captures.map((c) => c.id);
  const channels =
    ids.length === 0 ? [] : await CaptureChannel.findAll({ where: { capture_id: ids } });
  const componentIds = [
    ...new Set(channels.map((c) => c.component_id).filter((id) => Number.isInteger(id))),
  ];
  const componentRows =
    componentIds.length === 0
      ? []
      : await ModuleComponent.findAll({ where: { id: componentIds } });
  const moduleOfComponent = new Map(componentRows.map((c) => [c.id, c.module_id]));

  const patchIds = [...new Set(captures.map((c) => c.patch_id).filter(Boolean))];
  const patchModules =
    patchIds.length === 0 ? [] : await PatchModule.findAll({ where: { patch_id: patchIds } });
  const modulesOfPatch = new Map();
  for (const pm of patchModules) {
    if (!pm.module_id) continue;
    if (!modulesOfPatch.has(pm.patch_id)) modulesOfPatch.set(pm.patch_id, new Set());
    modulesOfPatch.get(pm.patch_id).add(pm.module_id);
  }

  const byCapture = new Map();
  for (const capture of captures) {
    const own = channels.filter((c) => c.capture_id === capture.id);
    const components = [
      ...new Set(own.map((c) => c.component_id).filter((id) => Number.isInteger(id))),
    ];
    const modules = new Set(
      components.map((id) => moduleOfComponent.get(id)).filter((id) => Number.isInteger(id))
    );
    for (const id of modulesOfPatch.get(capture.patch_id) ?? []) modules.add(id);
    if (Number.isInteger(capture.module_id)) modules.add(capture.module_id);
    byCapture.set(capture.id, {
      module_ids: [...modules],
      component_ids: components,
      channels: own,
    });
  }
  return byCapture;
}

// Which modules a set of recordings is about: the module a bench take hangs
// off, and the modules of the patch a patch take was made from. There are no
// per-jack channels on a recording — a patch's sound is one sound — so
// unlike a capture it narrows to modules only.
export async function audioLinks(db, recordings) {
  const { PatchModule } = db.models;
  const patchIds = [...new Set(recordings.map((a) => a.patch_id).filter(Boolean))];
  const patchModules =
    patchIds.length === 0 ? [] : await PatchModule.findAll({ where: { patch_id: patchIds } });
  const modulesOfPatch = new Map();
  for (const pm of patchModules) {
    if (!pm.module_id) continue;
    if (!modulesOfPatch.has(pm.patch_id)) modulesOfPatch.set(pm.patch_id, new Set());
    modulesOfPatch.get(pm.patch_id).add(pm.module_id);
  }
  const byRecording = new Map();
  for (const recording of recordings) {
    const modules = new Set(modulesOfPatch.get(recording.patch_id) ?? []);
    if (Number.isInteger(recording.module_id)) modules.add(recording.module_id);
    byRecording.set(recording.id, { module_ids: [...modules] });
  }
  return byRecording;
}

// The modules each patch uses, keyed by patch id — the same "actually in
// play" rule the signal flow and the patch document use.
export async function patchModulesByPatch(db, patchIds) {
  const { PatchModule, PatchCable, PatchSetting, PatchModuleLink } = db.models;
  const byPatch = new Map();
  if (patchIds.length === 0) return byPatch;
  const where = { patch_id: patchIds };
  const [rows, cables, settings, links] = await Promise.all([
    PatchModule.findAll({ where }),
    PatchCable.findAll({ where }),
    PatchSetting.findAll({ where }),
    PatchModuleLink.findAll({ where }),
  ]);
  for (const id of patchIds) {
    const engaged = engagedPatchModuleIds({
      cables: cables.filter((c) => c.patch_id === id),
      settings: settings.filter((s) => s.patch_id === id),
      links: links.filter((l) => l.patch_id === id),
    });
    byPatch.set(
      id,
      [
        ...new Set(
          rows
            .filter((pm) => pm.patch_id === id && engaged.has(pm.id) && pm.module_id)
            .map((pm) => pm.module_id)
        ),
      ]
    );
  }
  return byPatch;
}
