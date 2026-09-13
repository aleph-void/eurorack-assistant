// Compositions: what a storyboard may say, how it serializes, and how one of
// its elements is bound to something in a patch.
//
// A composition is the piece of paper propped against the case — the scenes
// of the music in order, the parts it is made of, and what each part does in
// each scene. It names no hardware, so it can be written before the patch
// exists and outlives the case being rebuilt. MAPPING it onto a patch is
// where the hardware comes in: each element is bound to the instance, the
// component, the bus or the cable that realises it there, and that binding
// is a soft reference with the target's name snapshotted beside it, like a
// cable's ends — the patch is edited after the mapping is made, and a
// mapping that outlives its target has to still say what it pointed at.

import { componentsOfPatchModule } from '../routes/patches/helpers.js';

export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_NOTE_LENGTH = 2000;
// A storyboard is something a person reads across: past this many columns
// or rows it is a spreadsheet, not a storyboard.
export const MAX_SCENES = 200;
export const MAX_ELEMENTS = 200;
export const MAX_MAPPINGS_PER_ELEMENT = 50;
// Twelve hours: longer than any set, short enough to catch a typo of
// milliseconds where seconds were meant.
export const MAX_DURATION_SECONDS = 12 * 60 * 60;

// What an element of a composition IS. `voice` plays notes; `rhythm` keeps
// time; `modulation` moves something else; `effect` colours what it is
// given; `texture` is the wash nothing else explains; `control` is a knob a
// hand rides during the piece rather than a sound at all. The client mirrors
// this list (client/src/compositionVocabulary.js).
export const ELEMENT_KINDS = [
  'voice',
  'rhythm',
  'modulation',
  'effect',
  'texture',
  'control',
  'other',
];

// What an element does in a scene: comes in, keeps going, does something
// (the note says what), goes out. A cell that does not exist is an element
// that is not playing then.
export const CELL_ACTIONS = ['enter', 'hold', 'change', 'exit'];

const NAME_INDEX = 'compositions_user_name_uniq';

export const nameTakenMessage = (name) => `you already have a composition called '${name}'`;

// A trimmed string cut to a limit, or null for nothing. Used for every
// free-text column here, so an emptied field stores as NULL rather than ''.
export const text = (value, max) => {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

// The user's composition of that name, if they have one. `exceptId` leaves
// one out, which is what lets a rename keep the name it already has.
export async function compositionNamed(db, userId, name, { exceptId = null } = {}) {
  const { Composition } = db.models;
  const rows = await Composition.findAll({
    where: { user_id: userId, name },
    attributes: ['id', 'name'],
  });
  return rows.find((c) => c.id !== exceptId) ?? null;
}

// Two requests can both find a name free; the unique index catches the
// second, and this says so, so the loser gets the 409 rather than a 500.
export function isCompositionNameConflict(error) {
  if (error?.name !== 'SequelizeUniqueConstraintError') return false;
  const constraint = error.parent?.constraint ?? error.original?.constraint ?? '';
  if (constraint) return constraint === NAME_INDEX;
  return (error.errors ?? []).some((e) => e.path === 'name' || e.path === NAME_INDEX);
}

// ---- serializers ----

export const compositionJson = (row, extra = {}) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? null,
  tempo_bpm: row.tempo_bpm ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
  ...extra,
});

export const sceneJson = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? null,
  duration_seconds: row.duration_seconds ?? null,
  position: row.position,
});

export const elementJson = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  description: row.description ?? null,
  position: row.position,
});

export const cellJson = (row) => ({
  id: row.id,
  scene_id: row.scene_id,
  element_id: row.element_id,
  action: row.action,
  note: row.note ?? null,
});

// Which of the four shapes a mapping row is, read off its columns: the
// CHECKs in migration 046 make exactly one of them true.
export function mappingKind(row) {
  if (row.cable_id !== null && row.cable_id !== undefined) return 'cable';
  if (row.group_id !== null && row.group_id !== undefined) return 'group';
  if (row.component_id !== null && row.component_id !== undefined) return 'component';
  return 'module';
}

export const mappingJson = (row, { live = true } = {}) => ({
  id: row.id,
  element_id: row.element_id,
  kind: mappingKind(row),
  patch_module_id: row.patch_module_id ?? null,
  component_id: row.component_id ?? null,
  group_id: row.group_id ?? null,
  cable_id: row.cable_id ?? null,
  target_label: row.target_label,
  note: row.note ?? null,
  position: row.position,
  // false when the thing this points at has since left the patch: the
  // instance was removed, the cable unplugged, the bus deleted. The label
  // still says what it was.
  live,
});

// ---- the storyboard, whole ----

// Everything a composition's page draws: the scenes and elements in order,
// the cells, and the patches it is mapped onto with how much of it each one
// covers.
export async function loadCompositionDetail(db, composition) {
  const {
    CompositionScene,
    CompositionElement,
    CompositionSceneElement,
    CompositionPatch,
    CompositionMapping,
    Patch,
  } = db.models;
  const order = [
    ['position', 'ASC'],
    ['id', 'ASC'],
  ];
  const [scenes, elements, realizations] = await Promise.all([
    CompositionScene.findAll({ where: { composition_id: composition.id }, order }),
    CompositionElement.findAll({ where: { composition_id: composition.id }, order }),
    CompositionPatch.findAll({
      where: { composition_id: composition.id },
      order: [['id', 'ASC']],
    }),
  ]);
  const cells = scenes.length
    ? await CompositionSceneElement.findAll({ where: { scene_id: scenes.map((s) => s.id) } })
    : [];
  // A cell whose element has gone is impossible (the FK cascades), but a
  // cell is only worth sending when both ends are in the lists above.
  const elementIds = new Set(elements.map((e) => e.id));
  const patches = realizations.length
    ? await Patch.findAll({ where: { id: realizations.map((r) => r.patch_id) } })
    : [];
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const mappings = realizations.length
    ? await CompositionMapping.findAll({
        where: { composition_patch_id: realizations.map((r) => r.id) },
        attributes: ['composition_patch_id', 'element_id'],
      })
    : [];
  const mappingCount = new Map();
  const mappedElements = new Map();
  for (const m of mappings) {
    mappingCount.set(m.composition_patch_id, (mappingCount.get(m.composition_patch_id) ?? 0) + 1);
    if (!mappedElements.has(m.composition_patch_id)) mappedElements.set(m.composition_patch_id, new Set());
    mappedElements.get(m.composition_patch_id).add(m.element_id);
  }
  return {
    ...compositionJson(composition),
    scenes: scenes.map(sceneJson),
    elements: elements.map(elementJson),
    cells: cells.filter((c) => elementIds.has(c.element_id)).map(cellJson),
    patches: realizations
      .filter((r) => patchById.has(r.patch_id))
      .map((r) => realizationSummaryJson(r, patchById.get(r.patch_id), {
        mapping_count: mappingCount.get(r.id) ?? 0,
        mapped_element_count: mappedElements.get(r.id)?.size ?? 0,
        element_count: elements.length,
      })),
  };
}

export const realizationSummaryJson = (row, patch, extra = {}) => ({
  id: row.id,
  composition_id: row.composition_id,
  patch_id: row.patch_id,
  patch_name: patch?.name ?? null,
  rack_name: patch?.rack_name ?? null,
  system_name: patch?.system_name ?? null,
  notes: row.notes ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
  ...extra,
});

// ---- binding an element to something in a patch ----

// "Make Noise Maths", plus "#2" when the patch holds several of the module
// and the role the patch gives this instance — the same name the client's
// pickers use (usePatchFacts.moduleLabel), so a label chosen here reads the
// same as the picker it was chosen from.
function instanceLabel(pm, twins) {
  const base = `${pm.manufacturer} ${pm.module_name}`.trim();
  const numbered = twins > 1 ? `${base} #${pm.instance}` : base;
  return pm.label ? `${numbered} (${pm.label})` : numbered;
}

const twinKey = (pm) => (pm.module_id === null ? `name:${pm.module_name}` : `id:${pm.module_id}`);

// The instances of a patch, each with the label the page would call it by.
async function labelledInstances(db, patch) {
  const { PatchModule } = db.models;
  const rows = await PatchModule.findAll({ where: { patch_id: patch.id } });
  const counts = new Map();
  for (const pm of rows) counts.set(twinKey(pm), (counts.get(twinKey(pm)) ?? 0) + 1);
  return new Map(rows.map((pm) => [pm.id, { pm, label: instanceLabel(pm, counts.get(twinKey(pm))) }]));
}

const cableLabel = (cable, instances) => {
  const from = instances.get(cable.from_patch_module_id)?.label ?? '(removed module)';
  const to = instances.get(cable.to_patch_module_id)?.label ?? '(removed module)';
  return `${from} ${cable.from_component_name} → ${to} ${cable.to_component_name}`;
};

// The one target a request names, checked against the patch, with the label
// it will be remembered by. Returns { target } — the four columns plus
// target_label — or { error }.
//
// Exactly one of patch_module_id (with or without component_id), group_id
// or cable_id, the same rule the CHECK holds the row to, so a request that
// names two is refused here with a sentence rather than by the database.
export async function resolveMappingTarget(db, patch, body = {}) {
  const { PatchGroup, PatchCable } = db.models;
  const idOf = (key) => {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  };
  const patchModuleId = idOf('patch_module_id');
  const componentId = idOf('component_id');
  const groupId = idOf('group_id');
  const cableId = idOf('cable_id');
  for (const [key, value] of [
    ['patch_module_id', patchModuleId],
    ['component_id', componentId],
    ['group_id', groupId],
    ['cable_id', cableId],
  ]) {
    if (Number.isNaN(value)) return { error: `${key} must be a record id` };
  }
  const named = [patchModuleId, groupId, cableId].filter((v) => v !== null).length;
  if (named === 0) {
    return { error: 'Name what realises the element: patch_module_id (with component_id for one control or jack), group_id or cable_id' };
  }
  if (named > 1) {
    return { error: 'A mapping binds an element to one thing: name only one of patch_module_id, group_id, cable_id' };
  }
  if (componentId !== null && patchModuleId === null) {
    return { error: 'component_id names a component of an instance: send patch_module_id with it' };
  }
  const empty = { patch_module_id: null, component_id: null, group_id: null, cable_id: null };

  if (groupId !== null) {
    const group = await PatchGroup.findOne({ where: { id: groupId, patch_id: patch.id } });
    if (!group) return { error: 'that bus is not part of this patch' };
    return { target: { ...empty, group_id: group.id, target_label: group.name } };
  }
  if (cableId !== null) {
    const cable = await PatchCable.findOne({ where: { id: cableId, patch_id: patch.id } });
    if (!cable) return { error: 'that cable is not part of this patch' };
    const instances = await labelledInstances(db, patch);
    return { target: { ...empty, cable_id: cable.id, target_label: cableLabel(cable, instances) } };
  }
  const instances = await labelledInstances(db, patch);
  const instance = instances.get(patchModuleId);
  if (!instance) return { error: 'that module is not part of this patch' };
  if (componentId === null) {
    return { target: { ...empty, patch_module_id: instance.pm.id, target_label: instance.label } };
  }
  // A component is a live module_components row, or a port the patch
  // declared on gear with no analysis behind it — the instance says which
  // namespace the id is in, exactly as a cable's ends do.
  const components = await componentsOfPatchModule(db, instance.pm);
  const component = components.find((c) => c.id === componentId);
  if (!component) return { error: 'that component does not belong to this module' };
  return {
    target: {
      ...empty,
      patch_module_id: instance.pm.id,
      component_id: component.id,
      target_label: `${instance.label} · ${component.name}`,
    },
  };
}

// One composition mapped onto one patch, whole: the pair's notes, the
// composition's elements, and every binding with whether its target is
// still in the patch.
export async function loadRealization(db, composition, realization, patch) {
  const { CompositionElement, CompositionMapping, PatchGroup, PatchCable } = db.models;
  const order = [
    ['position', 'ASC'],
    ['id', 'ASC'],
  ];
  const [elements, mappings, instances, groups, cables] = await Promise.all([
    CompositionElement.findAll({ where: { composition_id: composition.id }, order }),
    CompositionMapping.findAll({ where: { composition_patch_id: realization.id }, order }),
    labelledInstances(db, patch),
    PatchGroup.findAll({ where: { patch_id: patch.id }, attributes: ['id'] }),
    PatchCable.findAll({ where: { patch_id: patch.id }, attributes: ['id'] }),
  ]);
  const groupIds = new Set(groups.map((g) => g.id));
  const cableIds = new Set(cables.map((c) => c.id));
  // A component target is live while its instance is AND the component is
  // still one of that instance's connection points — a re-analysis rewrites
  // a module's components under new ids, which is the case the snapshot
  // label exists for. Looked up once per instance, not once per mapping.
  const componentsByInstance = new Map();
  const componentLive = async (m) => {
    const instance = instances.get(m.patch_module_id);
    if (!instance) return false;
    if (!componentsByInstance.has(instance.pm.id)) {
      componentsByInstance.set(instance.pm.id, await componentsOfPatchModule(db, instance.pm));
    }
    return componentsByInstance.get(instance.pm.id).some((c) => c.id === m.component_id);
  };
  const out = [];
  for (const m of mappings) {
    const kind = mappingKind(m);
    let live;
    if (kind === 'cable') live = cableIds.has(m.cable_id);
    else if (kind === 'group') live = groupIds.has(m.group_id);
    else if (kind === 'module') live = instances.has(m.patch_module_id);
    else live = await componentLive(m);
    out.push(mappingJson(m, { live }));
  }
  return {
    ...realizationSummaryJson(realization, patch),
    composition_name: composition.name,
    elements: elements.map(elementJson),
    mappings: out,
  };
}
