<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { parseQuickCable } from '../patchQuickCable.js';
import AutocompleteSelect from '../components/AutocompleteSelect.vue';
import ScopePanel from '../components/ScopePanel.vue';
import PatchNotesPanel from '../components/PatchNotesPanel.vue';
import PatchDiagram from '../components/PatchDiagram.vue';
import ShareButton from '../components/ShareButton.vue';
import VoicePatchPanel from '../components/VoicePatchPanel.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

// A capture files itself under a note on this patch, so the notes panel is
// refreshed when one is taken.
const notesPanel = ref(null);
const onCaptured = () => notesPanel.value?.load();

const patch = ref(null);
const error = ref('');

// ---- renaming ----
const renaming = ref(false);
const renameValue = ref('');
const renameError = ref('');

// ---- cable form ----
const fromModuleId = ref(''); // patch_module id
const fromComponentId = ref('');
const toModuleId = ref('');
const toComponentId = ref('');
const cableNote = ref('');
const cableOptional = ref(false);
const cableStacked = ref(false);
const cableAltGroup = ref('');
const cablePair = ref(false);
const cableError = ref('');
// Signal usually travels onward: with this on, the module a cable lands in
// becomes the source of the next one.
const chainFromDestination = ref(false);

// The four pickers, so choosing in one moves on to the next.
const fromModuleBox = ref(null);
const fromJackBox = ref(null);
const toModuleBox = ref(null);
const toJackBox = ref(null);
const focusBox = (box) => nextTick(() => box.value?.focus());

// A jack only belongs to the module it was picked on.
watch(fromModuleId, () => {
  fromComponentId.value = '';
});
watch(toModuleId, () => {
  toComponentId.value = '';
});

// ---- settings form ----
const settingsModuleId = ref(''); // patch_module id
const settingsError = ref('');
// Draft value per component id of the selected module instance.
const draft = reactive({});

// Cables worth plugging next, learned from the user's other patches.
const suggestions = ref([]);

async function loadSuggestions() {
  try {
    const res = await api.get(`/api/patches/${props.id}/suggestions`);
    suggestions.value = res?.suggestions ?? [];
  } catch {
    suggestions.value = [];
  }
}

async function load() {
  try {
    const loaded = await api.get(`/api/patches/${props.id}`);
    // Somebody else's patch, shared with you: this page is an editor and none
    // of it would work, so the read-only page is where that belongs.
    if (loaded.shared) {
      router.replace(`/shared/patch/${props.id}`);
      return;
    }
    patch.value = loaded;
    await loadSuggestions();
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

// Copy the whole patch: the same instances, cables, settings and buses under
// a new name, as the starting point for the next version of it.
const duplicating = ref(false);

async function duplicatePatch() {
  error.value = '';
  duplicating.value = true;
  try {
    const copy = await api.post(`/api/patches/${props.id}/clone`, {});
    router.push(`/patches/${copy.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    duplicating.value = false;
  }
}

const modules = computed(() => patch.value?.modules || []);
const modulesById = computed(() => new Map(modules.value.map((m) => [m.id, m])));
const groups = computed(() => patch.value?.groups || []);
const groupsById = computed(() => new Map(groups.value.map((g) => [g.id, g])));

// "Make Noise Maths", plus "#2" when the rack held several of the module and
// the role this instance plays in the patch when one has been recorded.
function moduleLabel(pm) {
  if (!pm) return '(removed module)';
  const twins =
    pm.module_id === null
      ? modules.value.filter((m) => m.module_id === null && m.module_name === pm.module_name).length
      : modules.value.filter((m) => m.module_id === pm.module_id).length;
  const base = `${pm.manufacturer} ${pm.module_name}`.trim();
  const numbered = twins > 1 ? `${base} #${pm.instance}` : base;
  return pm.label ? `${numbered} (${pm.label})` : numbered;
}

// A mult's bidirectional jacks can sit at either end of a cable: plugging
// into one makes it the group's input, the rest carry copies out.
const FROM_TYPES = ['output_jack', 'bidirectional_jack'];
const TO_TYPES = ['input_jack', 'bidirectional_jack'];

const portKindLabel = (kind) => (kind ? kind.replace(/_/g, ' ') : null);

function jackLabel(c) {
  const port = portKindLabel(c.port_kind);
  const suffix = c.type === 'bidirectional_jack' ? ` (mult${c.group_label ? ` ${c.group_label}` : ''})` : '';
  return `${c.name}${suffix}${port ? ` [${port}]` : ''}`;
}

const fromModules = computed(() =>
  modules.value.filter((m) => m.components.some((c) => FROM_TYPES.includes(c.type)))
);
const toModules = computed(() =>
  modules.value.filter((m) => m.components.some((c) => TO_TYPES.includes(c.type)))
);
const fromJacks = computed(
  () =>
    modulesById.value.get(Number(fromModuleId.value))?.components.filter((c) =>
      FROM_TYPES.includes(c.type)
    ) || []
);
const toJacks = computed(
  () =>
    modulesById.value.get(Number(toModuleId.value))?.components.filter((c) =>
      TO_TYPES.includes(c.type)
    ) || []
);

// ---- what the pickers offer ----
// Options are searched on their hint as well as their label, so a module can
// also be found by the role the patch gives it and a jack by what is already
// plugged into it.
const moduleOptions = (list) =>
  list.map((pm) => ({
    value: pm.id,
    label: moduleLabel(pm),
    hint: pm.live ? undefined : pm.external ? 'off-rack gear' : 'not in this rack',
  }));
const fromModuleOptions = computed(() => moduleOptions(fromModules.value));
const toModuleOptions = computed(() => moduleOptions(toModules.value));

const cables = computed(() => patch.value?.cables || []);
const cableInto = (pmId, componentId) =>
  cables.value.find((c) => c.to_patch_module_id === pmId && c.to_component_id === componentId) ??
  null;
const cablesOutOf = (pmId, componentId) =>
  cables.value.filter(
    (c) => c.from_patch_module_id === pmId && c.from_component_id === componentId
  );

// An output can fan out, so its list says how busy it already is; a mult jack
// a cable feeds is its group's input and the copies come out of the others.
const fromJackOptions = computed(() => {
  const pmId = Number(fromModuleId.value);
  return fromJacks.value.map((c) => {
    const feeding = cableInto(pmId, c.id);
    const out = cablesOutOf(pmId, c.id).length;
    let hint;
    if (feeding && c.type === 'bidirectional_jack') hint = 'mult input — copies come out of the others';
    else if (out) hint = out === 1 ? '1 cable already' : `${out} cables already`;
    return { value: c.id, label: jackLabel(c), hint };
  });
});

// An input takes exactly one cable, so one that is already fed is shown with
// what is in it rather than offered and refused.
const toJackOptions = computed(() => {
  const pmId = Number(toModuleId.value);
  return toJacks.value.map((c) => {
    const taken = cableInto(pmId, c.id);
    return {
      value: c.id,
      label: jackLabel(c),
      hint: taken ? `in use — ${taken.from_component_name} is patched here` : undefined,
      disabled: Boolean(taken),
    };
  });
});
const cableValid = computed(
  () => fromModuleId.value && fromComponentId.value && toModuleId.value && toComponentId.value
);

// Jacks that carry the two halves of one signal. When both ends of a cable
// are halves of a pair, the patch can plug the other half at the same time.
const pairs = computed(() => patch.value?.pairs || []);
function pairedWith(pmId, componentId) {
  const pair = pairs.value.find(
    (p) =>
      p.patch_module_id === Number(pmId) &&
      (p.a_component_id === Number(componentId) || p.b_component_id === Number(componentId))
  );
  if (!pair) return null;
  const otherId =
    pair.a_component_id === Number(componentId) ? pair.b_component_id : pair.a_component_id;
  return modulesById.value.get(Number(pmId))?.components.find((c) => c.id === otherId) ?? null;
}
const pairable = computed(() => {
  if (!cableValid.value) return null;
  const from = pairedWith(fromModuleId.value, fromComponentId.value);
  const to = pairedWith(toModuleId.value, toComponentId.value);
  return from && to ? { from, to } : null;
});

// ---- one line, one cable ----
// "maths eor > optomix ch1 in": both ends named in the words you would use
// out loud, resolved against every jack in the patch as you type.
const quickLine = ref('');
const quickError = ref('');

// jack_index is where this jack sits among the module's jacks of the same
// kind, counting from one. Typing never needs it, but "out one" said out loud
// on a module whose outputs are unnamed has to land somewhere.
const jackCandidates = (types, forDestination) =>
  modules.value.flatMap((pm) => {
    const wanted = pm.components.filter((c) => types.includes(c.type));
    const seen = new Map();
    return wanted.map((c) => {
      const index = (seen.get(c.type) || 0) + 1;
      seen.set(c.type, index);
      return {
        patch_module_id: pm.id,
        component_id: c.id,
        module_label: moduleLabel(pm),
        jack_name: c.name,
        jack_type: c.type,
        jack_index: index,
        disabled: forDestination ? Boolean(cableInto(pm.id, c.id)) : false,
      };
    });
  });
const quickParsed = computed(() =>
  parseQuickCable(quickLine.value, {
    from: jackCandidates(FROM_TYPES, false),
    to: jackCandidates(TO_TYPES, true),
  })
);
const quickReady = computed(
  () => Boolean(quickParsed.value.from && quickParsed.value.to && !quickParsed.value.error)
);
const endpointText = (end) => `${end.module_label} — ${end.jack_name}`;

// ---- the same two lists, said out loud ----
// Voice needs the ends kept whole rather than parsed from one line, the
// cables already plugged (so they can be pulled out by name), and the words
// this rack uses — a recogniser has never heard of Mimeophon and does better
// when it is told the names it should expect.
const voiceFrom = computed(() => jackCandidates(FROM_TYPES, false));
const voiceTo = computed(() => jackCandidates(TO_TYPES, true));
const cableCandidates = computed(() =>
  cables.value.map((c) => ({
    cable_id: c.id,
    module_label: `${moduleLabel(modulesById.value.get(c.from_patch_module_id))} ${c.from_component_name}`,
    jack_name: `${moduleLabel(modulesById.value.get(c.to_patch_module_id))} ${c.to_component_name}`,
  }))
);
const vocabulary = computed(() => {
  const words = new Set();
  for (const pm of modules.value) {
    words.add(pm.manufacturer);
    words.add(pm.module_name);
    if (pm.label) words.add(pm.label);
    for (const c of pm.components) words.add(c.name);
  }
  return [...words].filter(Boolean);
});

async function addQuickCable() {
  quickError.value = '';
  if (!quickReady.value) {
    quickError.value = quickParsed.value.error || 'Name both ends: source > destination';
    return;
  }
  const { from, to } = quickParsed.value;
  try {
    await api.post(`/api/patches/${props.id}/cables`, {
      from_patch_module_id: from.patch_module_id,
      from_component_id: from.component_id,
      to_patch_module_id: to.patch_module_id,
      to_component_id: to.component_id,
    });
    quickLine.value = '';
    await load();
  } catch (e) {
    quickError.value = e.message;
  }
}

async function addCable() {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/cables`, {
      from_patch_module_id: Number(fromModuleId.value),
      from_component_id: Number(fromComponentId.value),
      to_patch_module_id: Number(toModuleId.value),
      to_component_id: Number(toComponentId.value),
      note: cableNote.value.trim() || undefined,
      optional: cableOptional.value || undefined,
      stacked: cableStacked.value || undefined,
      alt_group: cableAltGroup.value.trim() || undefined,
      pair: cablePair.value && pairable.value ? true : undefined,
    });
    // Following the signal: the module this cable landed in sends the next
    // one. Otherwise the source stays put, ready for another cable out of it.
    const destination = toModuleId.value;
    fromComponentId.value = '';
    toComponentId.value = '';
    if (chainFromDestination.value) {
      toModuleId.value = '';
      fromModuleId.value = destination;
      focusBox(fromJackBox);
    } else {
      focusBox(fromModuleBox);
    }
    cableNote.value = '';
    cableOptional.value = false;
    cableStacked.value = false;
    cableAltGroup.value = '';
    cablePair.value = false;
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// The panel diagram only emits physical output → input gestures. Keep the
// write here alongside every other cable creator so errors land in the same
// visible place and the diagram refreshes from the server's canonical state.
async function connectDiagramCable(ends) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/cables`, ends);
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// Unplugging is not gated behind the modal the other removals use: patching
// is done by plugging and unplugging over and over, and a cable is one click
// away from being plugged again.
async function removeCable(cable) {
  cableError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/cables/${cable.id}`);
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// Load an existing cable back into the form to plug a variant of it — the
// same output into somewhere else, or the same input from somewhere else.
async function reuseCable(cable) {
  cableError.value = '';
  fromModuleId.value = cable.from_patch_module_id;
  toModuleId.value = cable.to_patch_module_id;
  // The module watchers clear the jacks, so the jacks are set after them.
  await nextTick();
  fromComponentId.value = cable.from_component_id;
  toComponentId.value = cable.to_component_id;
  focusBox(toModuleBox);
}

const jackOf = (pmId, componentId) =>
  modulesById.value.get(pmId)?.components.find((c) => c.id === componentId) ?? null;

// A cable can only be turned around when both jacks can play the other role:
// mult jacks, a bridged pair, a switch section. Everywhere else the ends are
// fixed by the panel.
function reversible(cable) {
  const from = jackOf(cable.from_patch_module_id, cable.from_component_id);
  const to = jackOf(cable.to_patch_module_id, cable.to_component_id);
  return Boolean(from && to && TO_TYPES.includes(from.type) && FROM_TYPES.includes(to.type));
}

async function reverseCable(cable) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/cables/${cable.id}/reverse`, {});
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// ---- suggestions ----
// Signal arrives at a module and nothing carries it onward. Off-rack gear is
// where a patch is supposed to end, so it is not a loose end.
const looseEnds = computed(() => {
  const fed = new Set(cables.value.map((c) => c.to_patch_module_id));
  const sending = new Set(cables.value.map((c) => c.from_patch_module_id));
  return modules.value.filter(
    (pm) =>
      fed.has(pm.id) &&
      !sending.has(pm.id) &&
      !pm.external &&
      pm.components.some((c) => FROM_TYPES.includes(c.type))
  );
});

async function plugSuggestion(suggestion) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/cables`, {
      from_patch_module_id: suggestion.from_patch_module_id,
      from_component_id: suggestion.from_component_id,
      to_patch_module_id: suggestion.to_patch_module_id,
      to_component_id: suggestion.to_component_id,
    });
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// Start a cable out of a module that has signal but sends none.
function patchFrom(pm) {
  fromModuleId.value = pm.id;
  focusBox(fromJackBox);
}

// Provisional cables and stackcables are recorded, not just drawn: toggling
// either one re-saves the cable in place.
async function toggleCableFlag(cable, field) {
  cableError.value = '';
  try {
    await api.put(`/api/patches/${props.id}/cables/${cable.id}`, { [field]: !cable[field] });
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
}

// ---- settings ----

const settingsModules = computed(() => modules.value.filter((m) => m.live));
const settingsModuleOptions = computed(() => moduleOptions(settingsModules.value));
const settingsModule = computed(() => modulesById.value.get(Number(settingsModuleId.value)));
// Controls you can dial in: everything that isn't a jack.
const settableComponents = computed(
  () => settingsModule.value?.components.filter((c) => !c.type.endsWith('_jack')) || []
);

function currentSetting(pmId, componentId) {
  return patch.value?.settings.find(
    (s) => s.patch_module_id === pmId && s.component_id === componentId
  );
}

// The recorded valid values shape each control: enum positions become a
// dropdown, a min/max range becomes a number input, anything else free text.
function control(component) {
  const options = (component.values || []).filter((v) => v.type === 'enum');
  if (options.length > 0) return { kind: 'enum', options };
  const min = (component.values || []).find((v) => v.type === 'min')?.value;
  const max = (component.values || []).find((v) => v.type === 'max')?.value;
  if (min !== undefined || max !== undefined) {
    const numeric = [min, max].every((v) => v === undefined || v.trim() === '' || !Number.isNaN(Number(v)));
    return { kind: numeric ? 'range' : 'text', min, max };
  }
  return { kind: 'text' };
}

function draftKey(pmId, componentId) {
  return `${pmId}:${componentId}`;
}

function draftValue(pmId, component) {
  const key = draftKey(pmId, component.id);
  if (!(key in draft)) {
    draft[key] = currentSetting(pmId, component.id)?.value ?? '';
  }
  return key;
}

async function saveSetting(component) {
  settingsError.value = '';
  const pmId = Number(settingsModuleId.value);
  try {
    await api.put(`/api/patches/${props.id}/settings`, {
      patch_module_id: pmId,
      component_id: component.id,
      value: draft[draftKey(pmId, component.id)],
    });
    await load();
  } catch (e) {
    settingsError.value = e.message;
  }
}

async function removeSetting(setting) {
  const ok = await dialog.confirm({
    title: 'Remove setting',
    message: `Remove the recorded '${setting.value}' for ${settingLabel(setting)}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  settingsError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/settings/${setting.id}`);
    delete draft[draftKey(setting.patch_module_id, setting.component_id)];
    await load();
  } catch (e) {
    settingsError.value = e.message;
  }
}

function settingLabel(setting) {
  return `${moduleLabel(modulesById.value.get(setting.patch_module_id))} — ${setting.component_name}`;
}

// ---- normalled connections ----
// Server-traced: each normalization is active until the cable that cancels it
// is patched, and its signals array names what actually arrives (following
// input→input chains through the patch's cables).
function signalText(s) {
  if (s.kind === 'cable') {
    const from = modulesById.value.get(s.from_patch_module_id);
    const via = s.via.length ? ` (via ${s.via.join(' → ')})` : '';
    return `${s.from_component_name} from ${moduleLabel(from)}${via}`;
  }
  if (s.kind === 'output') return `${s.component_name} (same module)`;
  if (s.kind === 'internal') return s.label;
  return 'nothing — the chain ends at an unpatched input';
}

function normalizationStatus(n) {
  if (!n.active) {
    const how = n.break_on === 'cable_out' ? 'out of' : 'into';
    return `a cable is patched ${how} ${n.break_component_name}`;
  }
  return `receives ${n.signals.map(signalText).join('; ')}`;
}

// "only with MODE set to LP" / "MODE is set to BP, so this default is one of
// several alternatives" — why a default may or may not be live.
function conditionText(condition) {
  if (!condition) return null;
  if (condition.state === 'selected') return `${condition.component_name} is set to ${condition.value}`;
  if (condition.state === 'unset') {
    return `only with ${condition.component_name} set to ${condition.value} — not recorded in this patch`;
  }
  return `only with ${condition.component_name} set to ${condition.value}`;
}

// ---- signal flow ----
// Server-built trees: one per signal source (generator outputs, internal
// normalled signals), flattened here into indented rows for display.
const EDGE_LABELS = {
  cable: 'cable',
  route: 'internal path',
  normal: 'normalled',
  mult: 'mult copy',
  switch: 'switch position',
  bridge: 'bridged link',
};

const flowRows = computed(() => {
  const rows = [];
  const walk = (node, depth) => {
    rows.push({ node, depth });
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const tree of patch.value?.flow || []) walk(tree, 0);
  return rows;
});

const flowTruncated = computed(() => (patch.value?.flow || []).some((t) => t.truncated_tree));

function flowNodeText(node) {
  return `${moduleLabel(modulesById.value.get(node.patch_module_id))} — ${node.name}`;
}

// ---- instances: names, labels and groups ----
const labelDraft = reactive({});
const nameDraft = reactive({});
const instanceError = ref('');

function labelKey(pm) {
  if (!(pm.id in labelDraft)) labelDraft[pm.id] = pm.label || '';
  return pm.id;
}

// The manufacturer and module name the patch snapshotted, editable in place
// so a typo or a piece of gear named in a hurry can be corrected. Both have
// to say something — an instance with no name cannot be picked out of the
// cable and settings pickers.
function nameKey(pm) {
  if (!(pm.id in nameDraft)) {
    nameDraft[pm.id] = {
      manufacturer: pm.manufacturer || '',
      module_name: pm.module_name || '',
    };
  }
  return pm.id;
}

function nameValid(pm) {
  const draft = nameDraft[pm.id];
  return Boolean(draft?.manufacturer.trim() && draft?.module_name.trim());
}

async function saveName(pm) {
  if (!nameValid(pm)) {
    instanceError.value = 'A manufacturer and a module name are both required.';
    return;
  }
  await saveInstance(pm, {
    manufacturer: nameDraft[pm.id].manufacturer.trim(),
    module_name: nameDraft[pm.id].module_name.trim(),
  });
}

async function saveInstance(pm, updates) {
  instanceError.value = '';
  try {
    await api.put(`/api/patches/${props.id}/modules/${pm.id}`, updates);
    await load();
  } catch (e) {
    instanceError.value = e.message;
  }
}

async function removeInstance(pm) {
  const ok = await dialog.confirm({
    title: 'Remove module from patch',
    message:
      `Take ${moduleLabel(pm)} out of this patch? Its cables, settings and links ` +
      'in this patch go with it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  instanceError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/modules/${pm.id}`);
    await load();
  } catch (e) {
    instanceError.value = e.message;
  }
}

// ---- groups (named buses / layers) ----
const groupName = ref('');
const groupError = ref('');

async function addGroup() {
  groupError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/groups`, { name: groupName.value.trim() });
    groupName.value = '';
    await load();
  } catch (e) {
    groupError.value = e.message;
  }
}

async function removeGroup(group) {
  const ok = await dialog.confirm({
    title: 'Remove bus',
    message: `Remove the '${group.name}' bus? The modules filed under it stay in the patch.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  groupError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/groups/${group.id}`);
    await load();
  } catch (e) {
    groupError.value = e.message;
  }
}

// Instances filed under each group, plus the ones not filed anywhere.
const groupedModules = computed(() => [
  ...groups.value.map((g) => ({
    group: g,
    members: modules.value.filter((m) => m.group_id === g.id),
  })),
  { group: null, members: modules.value.filter((m) => !m.group_id) },
]);

// ---- extra instances: more modules, borrowed modules, off-rack gear ----
const addKind = ref('rack'); // 'rack' | 'other' | 'external'
const addModuleId = ref('');
const addManufacturer = ref('');
const addName = ref('');
const addLabel = ref('');
const addError = ref('');
const rackModules = ref([]);

const rackModuleOptions = computed(() =>
  rackModules.value.map((m) => ({ value: m.id, label: `${m.manufacturer} ${m.name}`.trim() }))
);

const addValid = computed(() =>
  addKind.value === 'rack' ? Boolean(addModuleId.value) : addName.value.trim() !== ''
);

async function addInstance() {
  addError.value = '';
  try {
    const body = { label: addLabel.value.trim() || undefined };
    if (addKind.value === 'rack') body.module_id = Number(addModuleId.value);
    else {
      body.module_name = addName.value.trim();
      body.manufacturer = addManufacturer.value.trim() || undefined;
      body.external = addKind.value === 'external';
    }
    await api.post(`/api/patches/${props.id}/modules`, body);
    addModuleId.value = '';
    addManufacturer.value = '';
    addName.value = '';
    addLabel.value = '';
    await load();
  } catch (e) {
    addError.value = e.message;
  }
}

// ---- connection points declared inside the patch ----
// Off-rack gear and modules the rack does not hold have no analyzed
// components, so the patch says what they can be plugged into.
const portModuleId = ref('');
const portName = ref('');
const portType = ref('input_jack');
const portKind = ref('');
const portError = ref('');

const PORT_KINDS = [
  'midi_din',
  'midi_trs',
  'usb',
  'spdif',
  'adat',
  'audio_quarter_inch',
  'audio_rca',
  'ethernet',
  'microphone',
  'speaker',
  'memory_card',
  'ribbon',
  'other',
];

// Instances that declare their own connection points: anything with no live
// module behind it.
const declaredModules = computed(() => modules.value.filter((m) => !m.live));

async function addPort() {
  portError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/modules/${portModuleId.value}/ports`, {
      name: portName.value.trim(),
      type: portType.value,
      port_kind: portKind.value || undefined,
    });
    portName.value = '';
    await load();
  } catch (e) {
    portError.value = e.message;
  }
}

async function removePort(pm, port) {
  const ok = await dialog.confirm({
    title: 'Remove jack',
    message: `Remove ${jackLabel(port)} from ${moduleLabel(pm)}? Any cable plugged into it goes too.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  portError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/modules/${pm.id}/ports/${port.id}`);
    await load();
  } catch (e) {
    portError.value = e.message;
  }
}

// ---- links between instances ----
const links = computed(() => patch.value?.links || []);
const linkA = ref('');
const linkB = ref('');
const linkKind = ref('bridge');
const linkError = ref('');

async function addLink() {
  linkError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/links`, {
      a_patch_module_id: Number(linkA.value),
      b_patch_module_id: Number(linkB.value),
      kind: linkKind.value,
    });
    linkA.value = '';
    linkB.value = '';
    await load();
  } catch (e) {
    linkError.value = e.message;
  }
}

async function removeLink(link) {
  const ok = await dialog.confirm({
    title: 'Remove link',
    message: `Remove the ${link.kind} link between these two instances?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  linkError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/links/${link.id}`);
    await load();
  } catch (e) {
    linkError.value = e.message;
  }
}

async function rename() {
  renameError.value = '';
  try {
    await api.put(`/api/patches/${props.id}`, { name: renameValue.value });
    renaming.value = false;
    await load();
  } catch (e) {
    renameError.value = e.message;
  }
}

onMounted(async () => {
  try {
    const list = await api.get('/api/modules');
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
});
</script>

<template>
  <p><RouterLink to="/patches">← All patches</RouterLink></p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <template v-if="patch">
    <template v-if="renaming">
      <form class="actions" @submit.prevent="rename">
        <input v-model="renameValue" data-test="rename-input" />
        <button type="submit" data-test="rename-save">Save</button>
        <button type="button" @click="renaming = false">Cancel</button>
      </form>
      <p v-if="renameError" class="error">{{ renameError }}</p>
    </template>
    <h1 v-else>
      {{ patch.name }}
      <button
        style="margin: 0 0 0 0.6rem; font-size: 0.8rem"
        data-test="rename"
        @click="renaming = true; renameValue = patch.name"
      >
        Rename
      </button>
      <button
        style="margin: 0 0 0 0.4rem; font-size: 0.8rem"
        class="secondary"
        :disabled="duplicating"
        data-test="duplicate-patch"
        @click="duplicatePatch"
      >
        Duplicate
      </button>
      <ShareButton type="patch" :id="props.id" :label="patch.name" small />
      <a
        :href="`/api/patches/${props.id}/export`"
        style="margin-left: 0.6rem; font-size: 0.8rem"
        data-test="export-patch"
        title="Download this patch as a JSON file"
      >
        Export JSON
      </a>
      <RouterLink
        :to="`/ask?patch=${props.id}`"
        style="margin-left: 0.6rem; font-size: 0.8rem"
        data-test="ask-about-patch"
      >
        Ask about this patch
      </RouterLink>
    </h1>
    <p class="muted" data-test="snapshot-note">
      Snapshot of rack '{{ patch.rack_name }}' as of
      {{ new Date(patch.created_at).toLocaleString() }} — later changes to the rack do not affect
      this patch.
    </p>
    <p v-if="patch.description" style="white-space: pre-wrap">{{ patch.description }}</p>

    <PatchDiagram
      :modules="modules"
      :cables="patch.cables"
      :label-for="moduleLabel"
      :rack-rows="patch.rack_layout"
      interactive
      @connect="connectDiagramCable"
    />

    <VoicePatchPanel
      :patch-id="props.id"
      :from-candidates="voiceFrom"
      :to-candidates="voiceTo"
      :cable-candidates="cableCandidates"
      :vocabulary="vocabulary"
      @changed="load"
    />

    <details open class="panel" data-test="cables">
      <summary>
        <h2>Cables</h2>
        <span class="summary-count">
          {{ patch.cables.length }} {{ (patch.cables.length) === 1 ? 'cable' : 'cables' }}
        </span>
      </summary>
      <div class="panel-body">
        <div v-if="patch.cables.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>From (output)</th>
                <th>To (input)</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cable in patch.cables" :key="cable.id" :data-test="`cable-${cable.id}`">
                <td>
                  {{ moduleLabel(modulesById.get(cable.from_patch_module_id)) }} —
                  <strong>{{ cable.from_component_name }}</strong>
                </td>
                <td>
                  {{ moduleLabel(modulesById.get(cable.to_patch_module_id)) }} —
                  <strong>{{ cable.to_component_name }}</strong>
                </td>
                <td>
                  <span v-if="cable.optional" class="badge pending">optional</span>
                  <span v-if="cable.stacked" class="badge found">stacked</span>
                  <span v-if="cable.alt_group" class="badge pending">{{ cable.alt_group }}</span>
                  {{ cable.note || '' }}
                </td>
                <td>
                  <button
                    class="secondary"
                    style="margin: 0"
                    title="Load this cable into the form to plug a variant of it"
                    :data-test="`cable-reuse-${cable.id}`"
                    @click="reuseCable(cable)"
                  >
                    Reuse
                  </button>
                  <button
                    v-if="reversible(cable)"
                    class="secondary"
                    style="margin: 0 0 0 0.4rem"
                    title="Swap the ends of this cable"
                    :data-test="`cable-reverse-${cable.id}`"
                    @click="reverseCable(cable)"
                  >
                    Reverse
                  </button>
                  <button
                    style="margin: 0 0 0 0.4rem"
                    :data-test="`cable-optional-${cable.id}`"
                    @click="toggleCableFlag(cable, 'optional')"
                  >
                    {{ cable.optional ? 'Required' : 'Optional' }}
                  </button>
                  <button
                    style="margin: 0 0 0 0.4rem"
                    :data-test="`cable-stacked-${cable.id}`"
                    @click="toggleCableFlag(cable, 'stacked')"
                  >
                    {{ cable.stacked ? 'Not stacked' : 'Stacked' }}
                  </button>
                  <button
                    class="danger"
                    style="margin: 0 0 0 0.4rem"
                    :data-test="`delete-cable-${cable.id}`"
                    @click="removeCable(cable)"
                  >
                    Unplug
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No cables yet.</p>

        <form data-test="quick-form" @submit.prevent="addQuickCable">
          <label for="quick-cable">Quick entry — name both ends on one line</label>
          <div class="row">
            <div style="flex: 3">
              <input
                id="quick-cable"
                v-model="quickLine"
                data-test="quick-cable"
                placeholder="e.g. maths eor > optomix ch1 in"
              />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!quickReady" data-test="quick-create">
                Plug in
              </button>
            </div>
          </div>
          <p v-if="quickReady" class="muted" data-test="quick-preview">
            {{ endpointText(quickParsed.from) }} → {{ endpointText(quickParsed.to) }}
          </p>
          <template v-else-if="quickParsed.error">
            <p class="muted" data-test="quick-problem">{{ quickParsed.error }}</p>
            <p v-if="quickParsed.matches.length" class="muted" data-test="quick-matches">
              {{ quickParsed.matches.map(endpointText).join(' · ') }}
            </p>
          </template>
          <p v-if="quickError" class="error" data-test="quick-error">{{ quickError }}</p>
        </form>

        <form data-test="cable-form" @submit.prevent="addCable">
          <h3 style="margin-bottom: 0">Add a cable</h3>
          <p class="muted" style="margin: 0.2rem 0 0">
            Type to find each end — the arrow keys move through the matches, Enter takes the
            highlighted one and moves on to the next field.
          </p>
          <div class="row">
            <div>
              <label for="cable-from-module">From module</label>
              <AutocompleteSelect
                ref="fromModuleBox"
                v-model="fromModuleId"
                input-id="cable-from-module"
                data-test="cable-from-module"
                placeholder="Type a manufacturer, module or role…"
                :options="fromModuleOptions"
                @select="focusBox(fromJackBox)"
              />
            </div>
            <div>
              <label for="cable-from-jack">Output jack</label>
              <AutocompleteSelect
                ref="fromJackBox"
                v-model="fromComponentId"
                input-id="cable-from-jack"
                data-test="cable-from-jack"
                placeholder="Type a jack name…"
                empty-text="No output or mult jack matches"
                :disabled="!fromModuleId"
                :options="fromJackOptions"
                @select="focusBox(toModuleBox)"
              />
            </div>
            <div>
              <label for="cable-to-module">To module</label>
              <AutocompleteSelect
                ref="toModuleBox"
                v-model="toModuleId"
                input-id="cable-to-module"
                data-test="cable-to-module"
                placeholder="Type a manufacturer, module or role…"
                :options="toModuleOptions"
                @select="focusBox(toJackBox)"
              />
            </div>
            <div>
              <label for="cable-to-jack">Input jack</label>
              <AutocompleteSelect
                ref="toJackBox"
                v-model="toComponentId"
                input-id="cable-to-jack"
                data-test="cable-to-jack"
                placeholder="Type a jack name…"
                empty-text="No free input or mult jack matches"
                :disabled="!toModuleId"
                :options="toJackOptions"
              />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!cableValid" data-test="cable-create">
                Plug in
              </button>
            </div>
          </div>
          <div class="row">
            <div class="shrink">
              <label for="cable-chain">Chain — the next cable starts where this one lands</label>
              <input id="cable-chain" v-model="chainFromDestination" type="checkbox" data-test="cable-chain" />
            </div>
          </div>
          <div class="row">
            <div style="flex: 2">
              <label for="cable-note">Note (optional)</label>
              <input
                id="cable-note"
                v-model="cableNote"
                data-test="cable-note"
                placeholder="e.g. adds the distortion layer"
              />
            </div>
            <div>
              <label for="cable-alt-group">Alternative to (optional)</label>
              <input
                id="cable-alt-group"
                v-model="cableAltGroup"
                data-test="cable-alt-group"
                placeholder="e.g. vca choice"
              />
            </div>
            <div class="shrink">
              <label for="cable-optional">Provisional</label>
              <input id="cable-optional" v-model="cableOptional" type="checkbox" data-test="cable-optional" />
            </div>
            <div class="shrink">
              <label for="cable-stacked">Stackcable / mult</label>
              <input id="cable-stacked" v-model="cableStacked" type="checkbox" data-test="cable-stacked" />
            </div>
            <div v-if="pairable" class="shrink">
              <label for="cable-pair">
                Patch the pair ({{ pairable.from.name }} → {{ pairable.to.name }} too)
              </label>
              <input id="cable-pair" v-model="cablePair" type="checkbox" data-test="cable-pair" />
            </div>
          </div>
          <p v-if="cableError" class="error" data-test="cable-error">{{ cableError }}</p>
        </form>
      </div>
    </details>

    <details v-if="suggestions.length || looseEnds.length" class="panel" data-test="suggestions">
      <summary>
        <h2>What to patch next</h2>
        <span class="summary-count">{{ suggestions.length + looseEnds.length }}</span>
      </summary>
      <div class="panel-body">
        <template v-if="suggestions.length">
          <p class="muted">
            Cables you have plugged in your other patches, waiting to be plugged here — a rack is
            patched in habits.
          </p>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr
                  v-for="s in suggestions"
                  :key="`${s.from_patch_module_id}:${s.from_component_id}-${s.to_patch_module_id}:${s.to_component_id}`"
                  :data-test="`suggestion-${s.from_component_id}-${s.to_component_id}`"
                >
                  <td>
                    {{ moduleLabel(modulesById.get(s.from_patch_module_id)) }} —
                    <strong>{{ s.from_component_name }}</strong>
                    →
                    {{ moduleLabel(modulesById.get(s.to_patch_module_id)) }} —
                    <strong>{{ s.to_component_name }}</strong>
                  </td>
                  <td class="muted">
                    in {{ s.patches }} other {{ s.patches === 1 ? 'patch' : 'patches' }}
                  </td>
                  <td>
                    <button
                      style="margin: 0"
                      :data-test="`plug-suggestion-${s.from_component_id}-${s.to_component_id}`"
                      @click="plugSuggestion(s)"
                    >
                      Plug in
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-if="looseEnds.length">
          <h3>Loose ends</h3>
          <p class="muted">
            Signal reaches these modules and nothing carries it onward. That is a patch in progress —
            or a module doing its work through a normalled connection.
          </p>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr v-for="pm in looseEnds" :key="pm.id" :data-test="`loose-end-${pm.id}`">
                  <td>{{ moduleLabel(pm) }}</td>
                  <td>
                    <button
                      class="secondary"
                      style="margin: 0"
                      :data-test="`patch-from-${pm.id}`"
                      @click="patchFrom(pm)"
                    >
                      Patch from here
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </details>

    <details v-if="patch.flow?.length" class="panel" data-test="flow">
      <summary>
        <h2>Signal flow</h2>
        <span class="summary-count">
          {{ flowRows.length }} {{ (flowRows.length) === 1 ? 'step' : 'steps' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Every signal source in the patch — generator outputs (which no internal path feeds) and
          internal normalled signals — traced through cables, mult copies, normalled connections,
          each module's internal signal paths, expander panels and bridged links to everywhere it
          goes. Splits show as branches; merges, alternatives (only one is live at a time) and
          feedback loops are flagged.
        </p>
        <p v-if="flowTruncated" class="muted" data-test="flow-truncated">
          One or more paths were cut short — this patch's graph is larger than the tracer follows
          in one tree.
        </p>
        <div
          v-for="(row, i) in flowRows"
          :key="i"
          :style="{ paddingLeft: `${row.depth * 1.4}rem`, padding: `0.15rem 0 0.15rem ${row.depth * 1.4}rem` }"
          :data-test="`flow-row-${i}`"
        >
          <span v-if="row.node.via" class="muted">{{ EDGE_LABELS[row.node.via] || row.node.via }} → </span>
          <strong v-if="row.depth === 0">{{ flowNodeText(row.node) }}</strong>
          <template v-else>{{ flowNodeText(row.node) }}</template>
          <span v-if="row.node.port_kind" class="badge">{{ portKindLabel(row.node.port_kind) }}</span>
          <span v-if="row.depth === 0" class="badge found">
            {{ row.node.kind === 'internal' ? 'internal source' : 'generator' }}
          </span>
          <span v-if="row.node.switched && !row.node.conditional" class="badge pending">
            one switch position
          </span>
          <span v-if="row.node.conditional" class="badge pending">
            {{ conditionText(row.node.condition) }}
          </span>
          <span v-if="row.node.optional" class="badge pending">optional cable</span>
          <span v-if="row.node.merge" class="badge pending">merge point</span>
          <span v-if="row.node.switched_merge" class="badge pending">
            switched — one source at a time
          </span>
          <span v-if="row.node.cycle" class="badge failed">feedback loop ↺</span>
          <span v-if="row.node.truncated" class="badge failed">…path cut short</span>
        </div>
      </div>
    </details>

    <details v-if="patch.normalizations?.length" class="panel" data-test="normalled">
      <summary>
        <h2>Normalled connections in this patch</h2>
        <span class="summary-count">
          {{ patch.normalizations.length }}
          {{ patch.normalizations.length === 1 ? 'connection' : 'connections' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Built-in default connections. Each one stays active until the cable that cancels it is
          patched; chained normals are traced to the signal that actually arrives. Defaults that
          depend on a switch position show which setting they need.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th>Jack</th>
                <th>Normalled to</th>
                <th>Only when</th>
                <th>In this patch</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="n in patch.normalizations"
                :key="`${n.patch_module_id}-${n.normalization_id}`"
                :data-test="`normalled-${n.patch_module_id}-${n.normalization_id}`"
              >
                <td>{{ moduleLabel(modulesById.get(n.patch_module_id)) }}</td>
                <td>{{ n.target_component_name }}</td>
                <td>{{ n.source_component_name || n.source_label }}</td>
                <td>
                  {{ conditionText(n.condition) || 'always' }}
                  <span v-if="n.exclusive" class="badge pending">one of several</span>
                </td>
                <td>
                  <span class="badge" :class="n.active ? 'found' : 'pending'">
                    {{ n.active ? 'active' : 'overridden' }}
                  </span>
                  {{ normalizationStatus(n) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </details>

    <details class="panel" data-test="settings">
      <summary>
        <h2>Control settings</h2>
        <span class="summary-count">
          {{ patch.settings.length }}
          {{ patch.settings.length === 1 ? 'setting' : 'settings' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          How each control is dialed in. Settings are more than a record: a switch that decides
          which signal is normalled to an input, or turns an output into a channel mix, resolves
          the signal flow above once its position is recorded here.
        </p>
        <div v-if="patch.settings.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Control</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="setting in patch.settings" :key="setting.id" :data-test="`setting-${setting.id}`">
                <td>{{ settingLabel(setting) }}</td>
                <td>
                  <strong>{{ setting.value }}</strong>
                </td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-setting-${setting.id}`"
                    @click="removeSetting(setting)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No settings recorded yet.</p>

        <div class="row">
          <div>
            <label for="settings-module">Dial in a module — type to find it</label>
            <AutocompleteSelect
              v-model="settingsModuleId"
              input-id="settings-module"
              data-test="settings-module"
              placeholder="Type a manufacturer, module or role…"
              :options="settingsModuleOptions"
            />
          </div>
        </div>

        <div v-if="settingsModule && settableComponents.length" class="table-wrap">
          <table data-test="settings-controls">
            <thead>
              <tr>
                <th>Control</th>
                <th>Type</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in settableComponents" :key="c.id" :data-test="`control-${c.id}`">
                <td>
                  {{ c.name }}
                  <span v-if="currentSetting(Number(settingsModuleId), c.id)" class="badge found">set</span>
                </td>
                <td>{{ c.type }}</td>
                <td>
                  <template v-if="control(c).kind === 'enum'">
                    <select v-model="draft[draftValue(Number(settingsModuleId), c)]" :data-test="`control-input-${c.id}`">
                      <option value="" disabled>Select…</option>
                      <option v-for="v in control(c).options" :key="v.id" :value="v.value">
                        {{ v.value }}{{ v.description ? ` — ${v.description}` : '' }}
                      </option>
                    </select>
                  </template>
                  <template v-else-if="control(c).kind === 'range'">
                    <input
                      v-model="draft[draftValue(Number(settingsModuleId), c)]"
                      type="number"
                      step="any"
                      :min="control(c).min"
                      :max="control(c).max"
                      :placeholder="`${control(c).min ?? '?'} … ${control(c).max ?? '?'}`"
                      :data-test="`control-input-${c.id}`"
                    />
                  </template>
                  <template v-else>
                    <input
                      v-model="draft[draftValue(Number(settingsModuleId), c)]"
                      :placeholder="'e.g. 12 o\'clock'"
                      :data-test="`control-input-${c.id}`"
                    />
                  </template>
                </td>
                <td>
                  <button
                    style="margin: 0"
                    :disabled="!String(draft[draftKey(Number(settingsModuleId), c.id)] ?? '').trim()"
                    :data-test="`control-save-${c.id}`"
                    @click="saveSetting(c)"
                  >
                    Set
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else-if="settingsModule" class="muted">
          This module has no knobs, switches or other controls recorded.
        </p>
        <p v-if="settingsError" class="error" data-test="settings-error">{{ settingsError }}</p>
      </div>
    </details>

    <details class="panel" data-test="links">
      <summary>
        <h2>Linked instances</h2>
        <span class="summary-count">
          {{ links.length }} {{ (links.length) === 1 ? 'link' : 'links' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Modules wired to each other without patch cables: a host and its expander panel, or a
          bridged pair carrying signals between two points of the system — where a signal patched
          into one panel comes out of the matching jack on the other.
        </p>
        <div v-if="links.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Modules</th>
                <th>Kind</th>
                <th>Bridged jacks</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="link in links" :key="link.id" :data-test="`link-${link.id}`">
                <td>
                  {{ moduleLabel(modulesById.get(link.a_patch_module_id)) }} ↔
                  {{ moduleLabel(modulesById.get(link.b_patch_module_id)) }}
                </td>
                <td>{{ link.kind }}</td>
                <td>
                  {{
                    link.jacks.length
                      ? link.jacks.map((j) => `${j.a_component_name}↔${j.b_component_name}`).join(', ')
                      : '—'
                  }}
                </td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-link-${link.id}`"
                    @click="removeLink(link)"
                  >
                    Unlink
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No linked instances in this patch.</p>

        <form @submit.prevent="addLink">
          <div class="row">
            <div>
              <label for="link-a">Module</label>
              <select id="link-a" v-model="linkA" data-test="link-a">
                <option value="" disabled>Select a module…</option>
                <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm) }}</option>
              </select>
            </div>
            <div>
              <label for="link-b">Linked to</label>
              <select id="link-b" v-model="linkB" data-test="link-b">
                <option value="" disabled>Select a module…</option>
                <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm) }}</option>
              </select>
            </div>
            <div>
              <label for="link-kind">Kind</label>
              <select id="link-kind" v-model="linkKind" data-test="link-kind">
                <option value="bridge">Bridge — jacks pair up by name</option>
                <option value="expander">Expander panel</option>
              </select>
            </div>
            <div class="shrink">
              <button
                type="submit"
                style="margin: 0"
                :disabled="!linkA || !linkB || linkA === linkB"
                data-test="link-create"
              >
                Link
              </button>
            </div>
          </div>
          <p v-if="linkError" class="error" data-test="link-error">{{ linkError }}</p>
        </form>
      </div>
    </details>

    <details class="panel" data-test="groups">
      <summary>
        <h2>Buses and layers</h2>
        <span class="summary-count">
          {{ groups.length }} {{ (groups.length) === 1 ? 'bus' : 'buss' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Name the groups a patch is really built from — a rhythm layer, a granular bus — and give
          each instance the role it plays, so "LXR #2" reads as the ghost-note voice it is. The
          manufacturer and module name are this patch's own, so correct either here when one came
          in wrong; both have to say something.
        </p>
        <div v-for="entry in groupedModules" :key="entry.group?.id ?? 'ungrouped'">
          <h3 v-if="entry.group" :data-test="`group-${entry.group.id}`">
            {{ entry.group.name }}
            <button
              class="danger"
              style="margin: 0 0 0 0.6rem; font-size: 0.8rem"
              :data-test="`delete-group-${entry.group.id}`"
              @click="removeGroup(entry.group)"
            >
              Remove
            </button>
          </h3>
          <h3 v-else-if="entry.members.length">Not in a bus</h3>
          <div v-if="entry.members.length" class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Manufacturer and module</th>
                  <th>Role in this patch</th>
                  <th>Bus</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pm in entry.members" :key="pm.id" :data-test="`instance-${pm.id}`">
                  <td class="actions">
                    <input
                      v-model="nameDraft[nameKey(pm)].manufacturer"
                      :data-test="`manufacturer-input-${pm.id}`"
                      placeholder="Manufacturer"
                      @keyup.enter="saveName(pm)"
                    />
                    <input
                      v-model="nameDraft[nameKey(pm)].module_name"
                      :data-test="`module-name-input-${pm.id}`"
                      placeholder="Module name"
                      @keyup.enter="saveName(pm)"
                    />
                    <span class="muted">#{{ pm.instance }}</span>
                    <button
                      :disabled="!nameValid(pm)"
                      :data-test="`name-save-${pm.id}`"
                      @click="saveName(pm)"
                    >
                      Save
                    </button>
                  </td>
                  <td class="actions">
                    <input
                      v-model="labelDraft[labelKey(pm)]"
                      :data-test="`label-input-${pm.id}`"
                      placeholder="e.g. snare voice"
                      @keyup.enter="saveInstance(pm, { label: labelDraft[pm.id] })"
                    />
                    <button
                      :data-test="`label-save-${pm.id}`"
                      @click="saveInstance(pm, { label: labelDraft[pm.id] })"
                    >
                      Save
                    </button>
                  </td>
                  <td>
                    <select
                      :value="pm.group_id ?? ''"
                      :data-test="`group-select-${pm.id}`"
                      @change="saveInstance(pm, { group_id: $event.target.value || null })"
                    >
                      <option value="">—</option>
                      <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
                    </select>
                  </td>
                  <td>
                    <button
                      class="danger"
                      style="margin: 0"
                      :data-test="`remove-instance-${pm.id}`"
                      @click="removeInstance(pm)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p v-if="instanceError" class="error" data-test="instance-error">{{ instanceError }}</p>

        <form @submit.prevent="addGroup">
          <div class="row">
            <div>
              <label for="group-name">New bus / layer</label>
              <input id="group-name" v-model="groupName" data-test="group-name" placeholder="e.g. Rhythm" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!groupName.trim()" data-test="group-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="groupError" class="error" data-test="group-error">{{ groupError }}</p>
        </form>
      </div>
    </details>

    <details class="panel" data-test="extras">
      <summary>
        <h2>Other gear in this patch</h2>
        <span class="summary-count">
          {{ declaredModules.length }} {{ (declaredModules.length) === 1 ? 'item' : 'items' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          A patch reaches past the rack: a computer and its DAW at the end of an audio interface,
          the MIDI source driving a sequencer, the monitors everything lands in — and modules the
          patch calls for that this rack does not hold. Give each one the connection points it
          needs and cable it up like any other module.
        </p>
        <div v-if="declaredModules.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Connection points</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pm in declaredModules" :key="pm.id" :data-test="`declared-${pm.id}`">
                <td>{{ moduleLabel(pm) }}</td>
                <td>
                  <span class="badge" :class="pm.external ? 'pending' : 'failed'">
                    {{ pm.external ? 'off-rack gear' : 'not in this rack' }}
                  </span>
                </td>
                <td>
                  <span v-for="port in pm.components" :key="port.id" style="margin-right: 0.6rem">
                    {{ jackLabel(port) }}
                    <button
                      class="danger"
                      style="margin: 0; font-size: 0.75rem"
                      :data-test="`delete-port-${port.id}`"
                      @click="removePort(pm, port)"
                    >
                      ×
                    </button>
                  </span>
                  <span v-if="!pm.components.length" class="muted">none yet</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <form @submit.prevent="addInstance">
          <div class="row">
            <div>
              <label for="add-kind">Add</label>
              <select id="add-kind" v-model="addKind" data-test="add-kind">
                <option value="rack">Another instance of a module you own</option>
                <option value="other">A module this rack does not hold</option>
                <option value="external">Off-rack gear (DAW, MIDI, PA…)</option>
              </select>
            </div>
            <div v-if="addKind === 'rack'">
              <label for="add-module">Module</label>
              <AutocompleteSelect
                v-model="addModuleId"
                input-id="add-module"
                data-test="add-module"
                placeholder="Type a manufacturer or module…"
                :options="rackModuleOptions"
              />
            </div>
            <template v-else>
              <div>
                <label for="add-manufacturer">Manufacturer (optional)</label>
                <input id="add-manufacturer" v-model="addManufacturer" data-test="add-manufacturer" />
              </div>
              <div>
                <label for="add-name">Name</label>
                <input
                  id="add-name"
                  v-model="addName"
                  data-test="add-name"
                  placeholder="e.g. Behringer UMC404HD"
                />
              </div>
            </template>
            <div>
              <label for="add-label">Role (optional)</label>
              <input id="add-label" v-model="addLabel" data-test="add-label" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!addValid" data-test="add-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="addError" class="error" data-test="add-error">{{ addError }}</p>
        </form>

        <form v-if="declaredModules.length" @submit.prevent="addPort">
          <div class="row">
            <div>
              <label for="port-module">Declare a connection point on</label>
              <select id="port-module" v-model="portModuleId" data-test="port-module">
                <option value="" disabled>Select…</option>
                <option v-for="pm in declaredModules" :key="pm.id" :value="pm.id">
                  {{ moduleLabel(pm) }}
                </option>
              </select>
            </div>
            <div>
              <label for="port-name">Name</label>
              <input id="port-name" v-model="portName" data-test="port-name" placeholder="e.g. MIDI OUT" />
            </div>
            <div>
              <label for="port-type">Direction</label>
              <select id="port-type" v-model="portType" data-test="port-type">
                <option value="output_jack">Output</option>
                <option value="input_jack">Input</option>
                <option value="bidirectional_jack">Either way</option>
              </select>
            </div>
            <div>
              <label for="port-kind">Connector</label>
              <select id="port-kind" v-model="portKind" data-test="port-kind">
                <option value="">3.5mm patch point</option>
                <option v-for="k in PORT_KINDS" :key="k" :value="k">{{ portKindLabel(k) }}</option>
              </select>
            </div>
            <div class="shrink">
              <button
                type="submit"
                style="margin: 0"
                :disabled="!portModuleId || !portName.trim()"
                data-test="port-create"
              >
                Declare
              </button>
            </div>
          </div>
          <p v-if="portError" class="error" data-test="port-error">{{ portError }}</p>
        </form>
      </div>
    </details>

    <ScopePanel :patch-id="props.id" :modules="modules" @captured="onCaptured" />

    <PatchNotesPanel ref="notesPanel" :patch-id="props.id" />

    <details class="panel" data-test="snapshot">
      <summary>
        <h2>Modules in this patch</h2>
        <span class="summary-count">
          {{ modules.length }} {{ (modules.length) === 1 ? 'module' : 'modules' }}
        </span>
      </summary>
      <div class="panel-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th>Bus</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pm in modules" :key="pm.id" :data-test="`patch-module-${pm.id}`">
                <td>
                  <RouterLink v-if="pm.live" :to="`/modules/${pm.module_id}`">
                    {{ moduleLabel(pm) }}
                  </RouterLink>
                  <template v-else>{{ moduleLabel(pm) }}</template>
                </td>
                <td>{{ groupsById.get(pm.group_id)?.name || '—' }}</td>
                <td>
                  <span
                    class="badge"
                    :class="pm.live ? 'found' : pm.external ? 'pending' : 'failed'"
                  >
                    {{
                      pm.live
                        ? 'in your system'
                        : pm.external
                          ? 'off-rack gear'
                          : 'no longer in your system'
                    }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </details>
  </template>
</template>
