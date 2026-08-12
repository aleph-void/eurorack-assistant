<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });

const patch = ref(null);
const error = ref('');

// ---- renaming ----
const renaming = ref(false);
const renameValue = ref('');
const renameError = ref('');

// ---- cable form ----
const cableFilter = ref('');
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

// ---- settings form ----
const settingsFilter = ref('');
const settingsModuleId = ref(''); // patch_module id
const settingsError = ref('');
// Draft value per component id of the selected module instance.
const draft = reactive({});

async function load() {
  try {
    patch.value = await api.get(`/api/patches/${props.id}`);
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

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

// Type-to-find: narrow the module dropdowns by manufacturer, module name or
// the label the patch gives the instance.
function matchesFilter(pm, filter) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return `${pm.manufacturer} ${pm.module_name} ${pm.label || ''}`.toLowerCase().includes(needle);
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

const cableModules = computed(() => modules.value.filter((m) => matchesFilter(m, cableFilter.value)));
const fromModules = computed(() =>
  cableModules.value.filter((m) => m.components.some((c) => FROM_TYPES.includes(c.type)))
);
const toModules = computed(() =>
  cableModules.value.filter((m) => m.components.some((c) => TO_TYPES.includes(c.type)))
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
    fromComponentId.value = '';
    toComponentId.value = '';
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

async function removeCable(cable) {
  cableError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/cables/${cable.id}`);
    await load();
  } catch (e) {
    cableError.value = e.message;
  }
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

const settingsModules = computed(() =>
  modules.value.filter((m) => m.live && matchesFilter(m, settingsFilter.value))
);
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

// ---- instances: labels and groups ----
const labelDraft = reactive({});
const instanceError = ref('');

function labelKey(pm) {
  if (!(pm.id in labelDraft)) labelDraft[pm.id] = pm.label || '';
  return pm.id;
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
      <form style="display: inline" @submit.prevent="rename">
        <input v-model="renameValue" data-test="rename-input" style="width: auto" />
        <button type="submit" style="margin: 0 0 0 0.4rem" data-test="rename-save">Save</button>
        <button type="button" style="margin: 0 0 0 0.4rem" @click="renaming = false">Cancel</button>
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
    </h1>
    <p class="muted" data-test="snapshot-note">
      Snapshot of rack '{{ patch.rack_name }}' as of
      {{ new Date(patch.created_at).toLocaleString() }} — later changes to the rack do not affect
      this patch.
    </p>
    <p v-if="patch.description" style="white-space: pre-wrap">{{ patch.description }}</p>

    <div class="panel" data-test="cables">
      <h2>Cables</h2>
      <table v-if="patch.cables.length">
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
                style="margin: 0"
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
      <p v-else class="muted">No cables yet.</p>

      <form @submit.prevent="addCable">
        <label for="cable-filter">Add a cable — type to find a module</label>
        <div class="row">
          <input
            id="cable-filter"
            v-model="cableFilter"
            data-test="cable-filter"
            placeholder="Filter by manufacturer, module name or label…"
          />
        </div>
        <div class="row">
          <div>
            <label for="cable-from-module">From module</label>
            <select id="cable-from-module" v-model="fromModuleId" data-test="cable-from-module" @change="fromComponentId = ''">
              <option value="" disabled>Select a module…</option>
              <option v-for="pm in fromModules" :key="pm.id" :value="pm.id">
                {{ moduleLabel(pm) }}
              </option>
            </select>
          </div>
          <div>
            <label for="cable-from-jack">Output jack</label>
            <select id="cable-from-jack" v-model="fromComponentId" data-test="cable-from-jack">
              <option value="" disabled>Select an output…</option>
              <option v-for="c in fromJacks" :key="c.id" :value="c.id">{{ jackLabel(c) }}</option>
            </select>
          </div>
          <div>
            <label for="cable-to-module">To module</label>
            <select id="cable-to-module" v-model="toModuleId" data-test="cable-to-module" @change="toComponentId = ''">
              <option value="" disabled>Select a module…</option>
              <option v-for="pm in toModules" :key="pm.id" :value="pm.id">
                {{ moduleLabel(pm) }}
              </option>
            </select>
          </div>
          <div>
            <label for="cable-to-jack">Input jack</label>
            <select id="cable-to-jack" v-model="toComponentId" data-test="cable-to-jack">
              <option value="" disabled>Select an input…</option>
              <option v-for="c in toJacks" :key="c.id" :value="c.id">{{ jackLabel(c) }}</option>
            </select>
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!cableValid" data-test="cable-create">
              Plug in
            </button>
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

    <div v-if="patch.flow?.length" class="panel" data-test="flow">
      <h2>Signal flow</h2>
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

    <div v-if="patch.normalizations?.length" class="panel" data-test="normalled">
      <h2>Normalled connections in this patch</h2>
      <p class="muted">
        Built-in default connections. Each one stays active until the cable that cancels it is
        patched; chained normals are traced to the signal that actually arrives. Defaults that
        depend on a switch position show which setting they need.
      </p>
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

    <div class="panel" data-test="settings">
      <h2>Control settings</h2>
      <p class="muted">
        How each control is dialed in. Settings are more than a record: a switch that decides
        which signal is normalled to an input, or turns an output into a channel mix, resolves
        the signal flow above once its position is recorded here.
      </p>
      <table v-if="patch.settings.length">
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
      <p v-else class="muted">No settings recorded yet.</p>

      <label for="settings-filter">Dial in a module — type to find it</label>
      <div class="row">
        <input
          id="settings-filter"
          v-model="settingsFilter"
          data-test="settings-filter"
          placeholder="Filter by manufacturer or module name…"
        />
        <div>
          <select
            id="settings-module"
            v-model="settingsModuleId"
            data-test="settings-module"
            aria-label="Module"
          >
            <option value="" disabled>Select a module…</option>
            <option v-for="pm in settingsModules" :key="pm.id" :value="pm.id">
              {{ moduleLabel(pm) }}
            </option>
          </select>
        </div>
      </div>

      <table v-if="settingsModule && settableComponents.length" data-test="settings-controls">
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
      <p v-else-if="settingsModule" class="muted">
        This module has no knobs, switches or other controls recorded.
      </p>
      <p v-if="settingsError" class="error" data-test="settings-error">{{ settingsError }}</p>
    </div>

    <div class="panel" data-test="links">
      <h2>Linked instances</h2>
      <p class="muted">
        Modules wired to each other without patch cables: a host and its expander panel, or a
        bridged pair carrying signals between two points of the system — where a signal patched
        into one panel comes out of the matching jack on the other.
      </p>
      <table v-if="links.length">
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

    <div class="panel" data-test="groups">
      <h2>Buses and layers</h2>
      <p class="muted">
        Name the groups a patch is really built from — a rhythm layer, a granular bus — and give
        each instance the role it plays, so "LXR #2" reads as the ghost-note voice it is.
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
        <table v-if="entry.members.length">
          <thead>
            <tr>
              <th>Module</th>
              <th>Role in this patch</th>
              <th>Bus</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pm in entry.members" :key="pm.id" :data-test="`instance-${pm.id}`">
              <td>{{ pm.manufacturer }} {{ pm.module_name }} #{{ pm.instance }}</td>
              <td>
                <input
                  v-model="labelDraft[labelKey(pm)]"
                  :data-test="`label-input-${pm.id}`"
                  placeholder="e.g. snare voice"
                  @keyup.enter="saveInstance(pm, { label: labelDraft[pm.id] })"
                />
                <button
                  style="margin: 0 0 0 0.4rem"
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

    <div class="panel" data-test="extras">
      <h2>Other gear in this patch</h2>
      <p class="muted">
        A patch reaches past the rack: a computer and its DAW at the end of an audio interface,
        the MIDI source driving a sequencer, the monitors everything lands in — and modules the
        patch calls for that this rack does not hold. Give each one the connection points it
        needs and cable it up like any other module.
      </p>
      <table v-if="declaredModules.length">
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
            <select id="add-module" v-model="addModuleId" data-test="add-module">
              <option value="" disabled>Select a module…</option>
              <option v-for="m in rackModules" :key="m.id" :value="m.id">
                {{ m.manufacturer }} {{ m.name }}
              </option>
            </select>
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

    <div class="panel" data-test="snapshot">
      <h2>Modules in this patch</h2>
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
  </template>
</template>
