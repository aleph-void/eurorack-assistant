<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { useAuthStore } from '../stores/auth.js';

const props = defineProps({ id: { type: String, required: true } });

const auth = useAuthStore();
const module = ref(null);
const error = ref('');
const uploadError = ref('');
const uploading = ref(false);
const docName = ref('');

// Uploads need a label; 'manual' is reserved for the shared auto-found manual.
const docNameValid = computed(() => {
  const name = docName.value.trim();
  return name !== '' && name.toLowerCase() !== 'manual';
});

const TYPE_LABELS = {
  input_jack: 'Input jacks',
  output_jack: 'Output jacks',
  bidirectional_jack: 'Bidirectional jacks (mults)',
  knob: 'Knobs',
  slider: 'Sliders',
  button: 'Buttons',
  toggle: 'Toggles',
  switch: 'Switches',
  display: 'Displays',
  other: 'Other',
};

const grouped = computed(() => {
  if (!module.value?.components) return [];
  const groups = new Map();
  for (const c of module.value.components) {
    if (!groups.has(c.type)) groups.set(c.type, []);
    groups.get(c.type).push(c);
  }
  return [...groups.entries()].map(([type, components]) => ({
    type,
    label: TYPE_LABELS[type] || type,
    components,
  }));
});

const NORMALIZATION_KIND_LABELS = {
  input: 'from input',
  output: 'from output',
  internal: 'internal signal',
};

// The physical connector, for connection points that are not ordinary 3.5mm
// patch points.
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
const portKindLabel = (kind) => (kind ? kind.replace(/_/g, ' ') : '3.5mm');

// An expander's jacks live on its own module record but take part in this
// module's signal paths, so both sets are offered wherever a path is
// recorded — an expander jack is shown with the panel it sits on.
const linkedComponents = computed(() => module.value?.expander_components || []);
function panelName(moduleId) {
  const partner = (module.value?.expanders || []).find((e) => e.module_id === moduleId);
  return partner ? `${partner.manufacturer} ${partner.name}` : 'linked panel';
}
const patchableComponents = computed(() => [
  ...(module.value?.components || []),
  ...linkedComponents.value.map((c) => ({ ...c, panel: panelName(c.module_id) })),
]);
const componentLabel = (c) => (c.panel ? `${c.name} — ${c.panel}` : c.name);

// Human-readable source of a normalled connection: another jack on the
// module, or an internal signal with no panel component.
function normalizationSource(n) {
  return n.source_component_id ? componentName(n.source_component_id) : n.source_label;
}

// "MODE = LP", the control position a signal path depends on.
function conditionText(row) {
  if (!row.condition_component_id) return null;
  return `${componentName(row.condition_component_id)} = ${row.condition_value}`;
}

// What cancels a normalled connection, when it is not simply a cable in the
// target: Vhikk X's L output normalled to its R output breaks when a cable
// leaves L.
function breakText(n) {
  if (!n.break_component_id) return null;
  const how = n.break_on === 'cable_out' ? 'a cable out of' : 'a cable into';
  return `${how} ${componentName(n.break_component_id)}`;
}

// Controls (anything that isn't a jack) can gate a signal path, and their
// recorded positions become the values to choose from.
const controls = computed(
  () => module.value?.components?.filter((c) => !c.type.endsWith('_jack')) || []
);
function controlValues(componentId) {
  const control = controls.value.find((c) => c.id === Number(componentId));
  return (control?.values || []).filter((v) => v.type === 'enum');
}

// ---- manually recording normalled connections ----
const normTarget = ref(''); // component id
const normSource = ref(''); // component id, or 'internal' for a free-text signal
const normSourceLabel = ref('');
const normDescription = ref('');
const normConditionControl = ref('');
const normConditionValue = ref('');
const normAltGroup = ref('');
const normBreakJack = ref('');
const normBreakOn = ref('cable_in');
const normError = ref('');

// A normalled signal usually lands on an input, but an output normalled to
// another output is just as real, so every jack is offered as a target.
const inputJacks = computed(
  () => patchableComponents.value.filter((c) => c.type === 'input_jack') || []
);
const jacks = computed(() => patchableComponents.value.filter((c) => c.type.endsWith('_jack')));
const ownJacks = computed(
  () => module.value?.components?.filter((c) => c.type.endsWith('_jack')) || []
);
const normValid = computed(() => {
  if (!normTarget.value || !normSource.value) return false;
  if (normConditionControl.value && !normConditionValue.value.trim()) return false;
  if (normSource.value === 'internal') return normSourceLabel.value.trim() !== '';
  return Number(normSource.value) !== Number(normTarget.value);
});

// The condition and alternative-group fields shared by normalizations and
// routes: a path that only exists in one position of a control.
function conditionPayload(control, value, altGroup) {
  const payload = {};
  if (control) {
    payload.condition_component_id = Number(control);
    payload.condition_value = value.trim();
  }
  if (altGroup.trim()) payload.alt_group = altGroup.trim();
  return payload;
}

async function createNormalization() {
  normError.value = '';
  try {
    const payload = {
      target_component_id: Number(normTarget.value),
      ...conditionPayload(normConditionControl.value, normConditionValue.value, normAltGroup.value),
    };
    if (normSource.value === 'internal') payload.source_label = normSourceLabel.value.trim();
    else payload.source_component_id = Number(normSource.value);
    if (normBreakJack.value) {
      payload.break_component_id = Number(normBreakJack.value);
      payload.break_on = normBreakOn.value;
    }
    if (normDescription.value.trim()) payload.description = normDescription.value.trim();
    await api.post(`/api/modules/${props.id}/normalizations`, payload);
    normTarget.value = '';
    normSource.value = '';
    normSourceLabel.value = '';
    normDescription.value = '';
    normConditionControl.value = '';
    normConditionValue.value = '';
    normAltGroup.value = '';
    normBreakJack.value = '';
    normBreakOn.value = 'cable_in';
    await load();
  } catch (e) {
    normError.value = e.message;
  }
}

async function removeNormalization(n) {
  normError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/normalizations/${n.id}`);
    await load();
  } catch (e) {
    normError.value = e.message;
  }
}

// ---- internal signal paths (routes) ----
// Which inputs' signals appear at which outputs; outputs no route feeds are
// signal generators. Shared hardware facts, editable like normalizations.
const routeInput = ref('');
const routeOutput = ref('');
const routeDescription = ref('');
const routeConditionControl = ref('');
const routeConditionValue = ref('');
const routeAltGroup = ref('');
const routeError = ref('');

const outputJacks = computed(
  () => patchableComponents.value.filter((c) => c.type === 'output_jack') || []
);

// 'generator' for outputs nothing feeds, otherwise the inputs that reach it.
function outputSignalSource(c) {
  const feeding = (module.value?.routes || [])
    .filter((r) => r.output_component_id === c.id)
    .map((r) => componentName(r.input_component_id));
  return feeding.length === 0 ? 'generator' : `fed by ${feeding.join(', ')}`;
}

async function createRoute() {
  routeError.value = '';
  try {
    const payload = {
      input_component_id: Number(routeInput.value),
      output_component_id: Number(routeOutput.value),
      ...conditionPayload(
        routeConditionControl.value,
        routeConditionValue.value,
        routeAltGroup.value
      ),
    };
    if (routeDescription.value.trim()) payload.description = routeDescription.value.trim();
    await api.post(`/api/modules/${props.id}/routes`, payload);
    routeInput.value = '';
    routeOutput.value = '';
    routeDescription.value = '';
    routeConditionControl.value = '';
    routeConditionValue.value = '';
    routeAltGroup.value = '';
    await load();
  } catch (e) {
    routeError.value = e.message;
  }
}

async function removeRoute(route) {
  routeError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/routes/${route.id}`);
    await load();
  } catch (e) {
    routeError.value = e.message;
  }
}

// ---- routing switch sections ----
// A switch connects its common jack to one step jack at a time; which
// direction it runs is decided per patch by the cabling.
const switchCommon = ref('');
const switchSteps = ref([]);
const switchName = ref('');
const switchError = ref('');

const switchValid = computed(
  () => switchCommon.value && switchSteps.value.filter((id) => Number(id) !== Number(switchCommon.value)).length >= 2
);

async function createSwitch() {
  switchError.value = '';
  try {
    await api.post(`/api/modules/${props.id}/switches`, {
      common_component_id: Number(switchCommon.value),
      step_component_ids: switchSteps.value
        .map(Number)
        .filter((id) => id !== Number(switchCommon.value)),
      name: switchName.value.trim() || undefined,
    });
    switchCommon.value = '';
    switchSteps.value = [];
    switchName.value = '';
    await load();
  } catch (e) {
    switchError.value = e.message;
  }
}

async function removeSwitch(section) {
  switchError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/switches/${section.id}`);
    await load();
  } catch (e) {
    switchError.value = e.message;
  }
}

// ---- stereo (and other) jack pairs ----
// Two jacks that carry the two halves of one signal, so a patch can plug
// both ends in one step.
const pairA = ref('');
const pairB = ref('');
const pairKind = ref('stereo');
const pairError = ref('');

const pairValid = computed(
  () => pairA.value && pairB.value && Number(pairA.value) !== Number(pairB.value)
);

async function createPair() {
  pairError.value = '';
  try {
    await api.post(`/api/modules/${props.id}/pairs`, {
      a_component_id: Number(pairA.value),
      b_component_id: Number(pairB.value),
      kind: pairKind.value.trim() || 'stereo',
    });
    pairA.value = '';
    pairB.value = '';
    await load();
  } catch (e) {
    pairError.value = e.message;
  }
}

async function removePair(pair) {
  pairError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/pairs/${pair.id}`);
    await load();
  } catch (e) {
    pairError.value = e.message;
  }
}

// ---- expander panels ----
// Two modules joined by a ribbon cable that behave as one instrument. Once
// linked, this module's signal paths may reach the expander's jacks.
const expanderTarget = ref('');
const expanderError = ref('');
const rackModules = ref([]);

const expanderCandidates = computed(() =>
  rackModules.value.filter(
    (m) =>
      m.id !== Number(props.id) &&
      !(module.value?.expanders || []).some((e) => e.module_id === m.id)
  )
);

async function createExpander() {
  expanderError.value = '';
  try {
    await api.post(`/api/modules/${props.id}/expanders`, {
      expander_module_id: Number(expanderTarget.value),
    });
    expanderTarget.value = '';
    await load();
  } catch (e) {
    expanderError.value = e.message;
  }
}

async function removeExpander(link) {
  expanderError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/expanders/${link.id}`);
    await load();
  } catch (e) {
    expanderError.value = e.message;
  }
}

// ---- reclassifying components ----
// The analysis sometimes types a mult's jacks as plain inputs/outputs; any
// user with the module racked can correct a component's type and, for
// bidirectional (mult) jacks, its group.
const COMPONENT_TYPES = [
  'input_jack',
  'output_jack',
  'bidirectional_jack',
  'knob',
  'slider',
  'button',
  'toggle',
  'switch',
  'display',
  'other',
];
const editingComponentId = ref(null);
const editType = ref('');
const editGroup = ref('');
const editPortKind = ref('');
const editError = ref('');

function startEditComponent(c) {
  editingComponentId.value = c.id;
  editType.value = c.type;
  editGroup.value = c.group_label || '';
  editPortKind.value = c.port_kind || '';
  editError.value = '';
}

async function saveComponent(c) {
  editError.value = '';
  try {
    await api.put(`/api/modules/${props.id}/components/${c.id}`, {
      type: editType.value,
      group_label: editGroup.value,
      port_kind: editPortKind.value,
    });
    editingComponentId.value = null;
    await load();
  } catch (e) {
    editError.value = e.message;
  }
}

// ---- component values (valid settings) ----
const valueComponent = ref(''); // component id
const valueType = ref('enum');
const valueValue = ref('');
const valueDescription = ref('');
const valueError = ref('');

const allValues = computed(() =>
  (module.value?.components || []).flatMap((c) =>
    (c.values || []).map((v) => ({ ...v, component: c }))
  )
);

const valueValid = computed(() => valueComponent.value && valueValue.value.trim() !== '');

// "0 … 10" for a min/max range, "LP | BP | HP" for enum positions.
function valueSummary(c) {
  const values = c.values || [];
  const options = values.filter((v) => v.type === 'enum').map((v) => v.value);
  if (options.length > 0) return options.join(' | ');
  const min = values.find((v) => v.type === 'min')?.value;
  const max = values.find((v) => v.type === 'max')?.value;
  if (min === undefined && max === undefined) return '—';
  return `${min ?? '?'} … ${max ?? '?'}`;
}

async function createValue() {
  valueError.value = '';
  try {
    const payload = { type: valueType.value, value: valueValue.value.trim() };
    if (valueDescription.value.trim()) payload.description = valueDescription.value.trim();
    await api.post(
      `/api/modules/${props.id}/components/${valueComponent.value}/values`,
      payload
    );
    valueValue.value = '';
    valueDescription.value = '';
    await load();
  } catch (e) {
    valueError.value = e.message;
  }
}

async function removeValue(v) {
  valueError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/components/${v.component.id}/values/${v.id}`);
    await load();
  } catch (e) {
    valueError.value = e.message;
  }
}

function voltageRange(c) {
  if (c.voltage_min === null && c.voltage_max === null) return '—';
  const min = c.voltage_min === null ? '?' : `${c.voltage_min}V`;
  const max = c.voltage_max === null ? '?' : `${c.voltage_max}V`;
  return `${min} … ${max}`;
}

async function load() {
  try {
    module.value = await api.get(`/api/modules/${props.id}`);
  } catch (e) {
    error.value = e.message;
  }
  // Candidates for an expander link: the other modules in your racks.
  try {
    const list = await api.get('/api/modules');
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

async function uploadDocument(file) {
  uploadError.value = '';
  uploading.value = true;
  try {
    const data_base64 = await fileToBase64(file);
    await api.post(`/api/modules/${props.id}/manuals`, {
      name: docName.value.trim(),
      filename: file.name,
      data_base64,
    });
    docName.value = '';
    await load();
  } catch (e) {
    uploadError.value = e.message;
  } finally {
    uploading.value = false;
  }
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  if (file) await uploadDocument(file);
  event.target.value = '';
}

async function removeDocument(doc) {
  uploadError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/manuals/${doc.id}`);
    await load();
  } catch (e) {
    uploadError.value = e.message;
  }
}

// ---- notes ----
const noteBody = ref('');
const noteTarget = ref('module'); // 'module' or a component id
const noteError = ref('');

function componentName(componentId) {
  const own = module.value?.components?.find((c) => c.id === componentId);
  if (own) return own.name;
  // A jack on a linked expander panel, named with the panel it sits on.
  const linked = linkedComponents.value.find((c) => c.id === componentId);
  if (linked) return `${linked.name} (${panelName(linked.module_id)})`;
  return `#${componentId}`;
}

async function createNote() {
  noteError.value = '';
  try {
    const payload = { body: noteBody.value };
    if (noteTarget.value === 'module') payload.module_ids = [Number(props.id)];
    else payload.component_ids = [Number(noteTarget.value)];
    await api.post('/api/notes', payload);
    noteBody.value = '';
    noteTarget.value = 'module';
    await load();
  } catch (e) {
    noteError.value = e.message;
  }
}

async function detachNote(note) {
  noteError.value = '';
  try {
    const payload = note.component_id
      ? { component_id: note.component_id }
      : { module_id: Number(props.id) };
    await api.post(`/api/notes/${note.id}/detach`, payload);
    await load();
  } catch (e) {
    noteError.value = e.message;
  }
}

defineExpose({ uploadDocument });
onMounted(load);
</script>

<template>
  <p><RouterLink to="/modules">← All modules</RouterLink></p>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="module">
    <h1>{{ module.manufacturer }} {{ module.name }}</h1>
    <p>
      <span class="badge" :class="module.manual_status">manual: {{ module.manual_status }}</span>
      &nbsp;
      <span class="badge" :class="module.analysis_status">
        analysis: {{ module.analysis_status }}
      </span>
    </p>
    <p v-if="module.racks?.length" data-test="racks">
      In {{ module.racks.length === 1 ? 'rack' : 'racks' }}:
      {{ module.racks.map((r) => `${r.name} (×${r.quantity})`).join(', ') }}
      — <RouterLink to="/racks">manage racks</RouterLink>
    </p>

    <details v-if="module.summary" open class="panel" data-test="summary">
      <summary>
        <h2>Summary</h2>
      </summary>
      <div class="panel-body">
        <p style="white-space: pre-wrap">{{ module.summary }}</p>
      </div>
    </details>

    <details v-if="module.components?.length" class="panel" data-test="normalizations">
      <summary>
        <h2>Normalled connections</h2>
        <span class="summary-count">
          {{ module.normalizations?.length || 0 }}
          {{ module.normalizations?.length === 1 ? 'connection' : 'connections' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Default connections that exist until a cable overrides them — they are part of the
          signal path even with nothing plugged in. A default usually breaks when a cable is
          patched into its target, but an output normalled to another output breaks when a cable
          leaves the other jack instead. A default that only exists in one position of a switch
          carries that condition, and defaults sharing an alternatives label are never live at the
          same time.
        </p>
        <div v-if="module.normalizations?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jack</th>
                <th>Normalled to</th>
                <th>Kind</th>
                <th>Only when</th>
                <th>Breaks on</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in module.normalizations" :key="n.id" :data-test="`normalization-${n.id}`">
                <td>{{ componentName(n.target_component_id) }}</td>
                <td>{{ normalizationSource(n) }}</td>
                <td>{{ NORMALIZATION_KIND_LABELS[n.kind] || n.kind }}</td>
                <td :data-test="`normalization-condition-${n.id}`">
                  {{ conditionText(n) || 'always' }}
                  <span v-if="n.alt_group" class="badge pending">{{ n.alt_group }}</span>
                </td>
                <td>{{ breakText(n) || 'a cable into it' }}</td>
                <td>{{ n.description || '—' }}</td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-normalization-${n.id}`"
                    @click="removeNormalization(n)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No normalled connections recorded for this module.</p>

        <form @submit.prevent="createNormalization">
          <div class="row">
            <div>
              <label for="norm-target">Jack that receives it</label>
              <select id="norm-target" v-model="normTarget" data-test="norm-target">
                <option value="" disabled>Select a jack…</option>
                <option v-for="c in jacks" :key="c.id" :value="c.id">{{ componentLabel(c) }}</option>
              </select>
            </div>
            <div>
              <label for="norm-source">Normalled to</label>
              <select id="norm-source" v-model="normSource" data-test="norm-source">
                <option value="" disabled>Select a source…</option>
                <option v-for="c in jacks" :key="c.id" :value="c.id">
                  {{ componentLabel(c) }}
                  ({{ c.type === 'input_jack' ? 'input' : c.type === 'bidirectional_jack' ? 'mult' : 'output' }})
                </option>
                <option value="internal">Internal / unlisted signal…</option>
              </select>
            </div>
            <div v-if="normSource === 'internal'">
              <label for="norm-source-label">Signal name</label>
              <input
                id="norm-source-label"
                v-model="normSourceLabel"
                placeholder="e.g. internal oscillator"
                data-test="norm-source-label"
              />
            </div>
            <div style="flex: 2">
              <label for="norm-description">Description (optional)</label>
              <input id="norm-description" v-model="normDescription" data-test="norm-description" />
            </div>
          </div>
          <div class="row">
            <div>
              <label for="norm-break">Broken by (optional)</label>
              <select id="norm-break" v-model="normBreakJack" data-test="norm-break">
                <option value="">A cable into the target</option>
                <option v-for="c in jacks" :key="c.id" :value="c.id">{{ componentLabel(c) }}</option>
              </select>
            </div>
            <div v-if="normBreakJack">
              <label for="norm-break-on">…when it gets</label>
              <select id="norm-break-on" v-model="normBreakOn" data-test="norm-break-on">
                <option value="cable_in">a cable patched in</option>
                <option value="cable_out">a cable patched out</option>
              </select>
            </div>
            <div>
              <label for="norm-condition">Only when (optional)</label>
              <select
                id="norm-condition"
                v-model="normConditionControl"
                data-test="norm-condition"
                @change="normConditionValue = ''"
              >
                <option value="">Always</option>
                <option v-for="c in controls" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div v-if="normConditionControl">
              <label for="norm-condition-value">is set to</label>
              <select
                v-if="controlValues(normConditionControl).length"
                id="norm-condition-value"
                v-model="normConditionValue"
                data-test="norm-condition-value"
              >
                <option value="" disabled>Select a position…</option>
                <option v-for="v in controlValues(normConditionControl)" :key="v.id" :value="v.value">
                  {{ v.value }}
                </option>
              </select>
              <input
                v-else
                id="norm-condition-value"
                v-model="normConditionValue"
                placeholder="e.g. left"
                data-test="norm-condition-value"
              />
            </div>
            <div>
              <label for="norm-alt-group">Alternatives label (optional)</label>
              <input
                id="norm-alt-group"
                v-model="normAltGroup"
                placeholder="e.g. pwm source"
                data-test="norm-alt-group"
              />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!normValid" data-test="norm-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="normError" class="error" data-test="norm-error">{{ normError }}</p>
        </form>
      </div>
    </details>

    <details v-if="module.components?.length" class="panel" data-test="switches">
      <summary>
        <h2>Routing switches</h2>
        <span class="summary-count">
          {{ module.switches?.length || 0 }}
          {{ module.switches?.length === 1 ? 'switch' : 'switches' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          A switch section connects its common jack to exactly one step jack at a time. Patch a
          cable into the common to distribute it to the steps, or into the steps to select one of
          them onto the common — the direction follows your cabling, so bidirectional switches
          need no extra setup. Unlike a mult, only one connection is live at a time.
        </p>
        <div v-if="module.switches?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Section</th>
                <th>Common</th>
                <th>Steps</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in module.switches" :key="s.id" :data-test="`switch-${s.id}`">
                <td>{{ s.name || `Switch ${s.id}` }}</td>
                <td>{{ componentName(s.common_component_id) }}</td>
                <td>{{ s.step_component_ids.map(componentName).join(', ') }}</td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-switch-${s.id}`"
                    @click="removeSwitch(s)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No routing switches recorded for this module.</p>

        <form @submit.prevent="createSwitch">
          <div class="row">
            <div>
              <label for="switch-common">Common jack</label>
              <select id="switch-common" v-model="switchCommon" data-test="switch-common">
                <option value="" disabled>Select the common jack…</option>
                <option v-for="c in jacks" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label for="switch-steps">Step jacks (select two or more)</label>
              <select id="switch-steps" v-model="switchSteps" multiple data-test="switch-steps">
                <option v-for="c in jacks" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label for="switch-name">Name (optional)</label>
              <input id="switch-name" v-model="switchName" data-test="switch-name" placeholder="e.g. Section 1" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!switchValid" data-test="switch-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="switchError" class="error" data-test="switch-error">{{ switchError }}</p>
        </form>
      </div>
    </details>

    <details v-if="module.components?.length" class="panel" data-test="routes">
      <summary>
        <h2>Internal signal paths</h2>
        <span class="summary-count">
          {{ module.routes?.length || 0 }}
          {{ module.routes?.length === 1 ? 'path' : 'paths' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Which inputs' signals appear at which outputs (a mixer feeds every channel into the mix
          out; a filter feeds its audio input to each filter output). Output jacks that nothing
          feeds count as signal generators. These paths let a
          <RouterLink to="/patches">patch</RouterLink> trace signal flow straight through the
          module.
        </p>
        <div v-if="module.routes?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Appears at</th>
                <th>Only when</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in module.routes" :key="r.id" :data-test="`route-${r.id}`">
                <td>{{ componentName(r.input_component_id) }}</td>
                <td>{{ componentName(r.output_component_id) }}</td>
                <td :data-test="`route-condition-${r.id}`">
                  {{ conditionText(r) || 'always' }}
                  <span v-if="r.alt_group" class="badge pending">{{ r.alt_group }}</span>
                </td>
                <td>{{ r.description || '—' }}</td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-route-${r.id}`"
                    @click="removeRoute(r)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">
          No internal signal paths recorded — every output jack counts as a generator.
        </p>

        <form @submit.prevent="createRoute">
          <div class="row">
            <div>
              <label for="route-input">Input</label>
              <select id="route-input" v-model="routeInput" data-test="route-input">
                <option value="" disabled>Select an input…</option>
                <option v-for="c in inputJacks" :key="c.id" :value="c.id">
                  {{ componentLabel(c) }}
                </option>
              </select>
            </div>
            <div>
              <label for="route-output">Appears at output</label>
              <select id="route-output" v-model="routeOutput" data-test="route-output">
                <option value="" disabled>Select an output…</option>
                <option v-for="c in outputJacks" :key="c.id" :value="c.id">
                  {{ componentLabel(c) }}
                </option>
              </select>
            </div>
            <div>
              <label for="route-condition">Only when (optional)</label>
              <select
                id="route-condition"
                v-model="routeConditionControl"
                data-test="route-condition"
                @change="routeConditionValue = ''"
              >
                <option value="">Always</option>
                <option v-for="c in controls" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div v-if="routeConditionControl">
              <label for="route-condition-value">is set to</label>
              <select
                v-if="controlValues(routeConditionControl).length"
                id="route-condition-value"
                v-model="routeConditionValue"
                data-test="route-condition-value"
              >
                <option value="" disabled>Select a position…</option>
                <option v-for="v in controlValues(routeConditionControl)" :key="v.id" :value="v.value">
                  {{ v.value }}
                </option>
              </select>
              <input
                v-else
                id="route-condition-value"
                v-model="routeConditionValue"
                placeholder="e.g. up"
                data-test="route-condition-value"
              />
            </div>
            <div>
              <label for="route-alt-group">Alternatives label (optional)</label>
              <input id="route-alt-group" v-model="routeAltGroup" data-test="route-alt-group" />
            </div>
            <div style="flex: 2">
              <label for="route-description">Description (optional)</label>
              <input id="route-description" v-model="routeDescription" data-test="route-description" />
            </div>
            <div class="shrink">
              <button
                type="submit"
                style="margin: 0"
                :disabled="
                  !routeInput ||
                  !routeOutput ||
                  (routeConditionControl && !routeConditionValue.trim())
                "
                data-test="route-create"
              >
                Add
              </button>
            </div>
          </div>
          <p v-if="routeError" class="error" data-test="route-error">{{ routeError }}</p>
        </form>
      </div>
    </details>

    <details v-if="module.components?.length" class="panel" data-test="pairs">
      <summary>
        <h2>Stereo pairs</h2>
        <span class="summary-count">
          {{ module.pairs?.length || 0 }}
          {{ module.pairs?.length === 1 ? 'pair' : 'pairs' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Two jacks that carry the two halves of one signal. A patch can plug both ends of a pair
          in a single step instead of remembering to patch left and right separately.
        </p>
        <div v-if="module.pairs?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jack</th>
                <th>Paired with</th>
                <th>Kind</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in module.pairs" :key="p.id" :data-test="`pair-${p.id}`">
                <td>{{ componentName(p.a_component_id) }}</td>
                <td>{{ componentName(p.b_component_id) }}</td>
                <td>{{ p.kind }}</td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-pair-${p.id}`"
                    @click="removePair(p)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No pairs recorded for this module.</p>

        <form @submit.prevent="createPair">
          <div class="row">
            <div>
              <label for="pair-a">Jack</label>
              <select id="pair-a" v-model="pairA" data-test="pair-a">
                <option value="" disabled>Select a jack…</option>
                <option v-for="c in ownJacks" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label for="pair-b">Paired with</label>
              <select id="pair-b" v-model="pairB" data-test="pair-b">
                <option value="" disabled>Select a jack…</option>
                <option v-for="c in ownJacks" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label for="pair-kind">Kind</label>
              <input id="pair-kind" v-model="pairKind" data-test="pair-kind" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!pairValid" data-test="pair-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="pairError" class="error" data-test="pair-error">{{ pairError }}</p>
        </form>
      </div>
    </details>

    <details class="panel" data-test="expanders">
      <summary>
        <h2>Expander panels</h2>
        <span class="summary-count">
          {{ module.expanders?.length || 0 }}
          {{ module.expanders?.length === 1 ? 'panel' : 'panels' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          Modules joined to this one by a ribbon cable rather than patch cables — two panels that
          work as one instrument. Once linked, this module's internal signal paths and normalled
          connections may reach the expander's jacks, and a patch holding both traces signal
          straight across the pair.
        </p>
        <div v-if="module.expanders?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th>Relationship</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in module.expanders" :key="e.id" :data-test="`expander-${e.id}`">
                <td>
                  <RouterLink v-if="e.module_id" :to="`/modules/${e.module_id}`">
                    {{ e.manufacturer }} {{ e.name }}
                  </RouterLink>
                </td>
                <td>
                  {{ e.role === 'expander' ? 'expands this module' : 'this module expands it' }}
                </td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-expander-${e.id}`"
                    @click="removeExpander(e)"
                  >
                    Unlink
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No expander linked to this module.</p>

        <p
          v-for="(s, i) in module.expander_suggestions || []"
          :key="i"
          class="muted"
          :data-test="`expander-suggestion-${i}`"
        >
          The manual mentions
          <strong>{{ s.name }}</strong>
          {{ s.role === 'host' ? 'as the module this one expands' : 'as an expander for this module' }}.
          <template v-if="s.module_id">
            <RouterLink :to="`/modules/${s.module_id}`">It is in your racks</RouterLink> — link it
            below to trace signal across the pair.
          </template>
          <template v-else>It is not in any of your racks yet.</template>
        </p>

        <form @submit.prevent="createExpander">
          <div class="row">
            <div>
              <label for="expander-target">Link an expander</label>
              <select id="expander-target" v-model="expanderTarget" data-test="expander-target">
                <option value="" disabled>Select a module…</option>
                <option v-for="m in expanderCandidates" :key="m.id" :value="m.id">
                  {{ m.manufacturer }} {{ m.name }}
                </option>
              </select>
            </div>
            <div class="shrink">
              <button
                type="submit"
                style="margin: 0"
                :disabled="!expanderTarget"
                data-test="expander-create"
              >
                Link
              </button>
            </div>
          </div>
          <p v-if="expanderError" class="error" data-test="expander-error">{{ expanderError }}</p>
        </form>
      </div>
    </details>

    <details v-if="module.components?.length" class="panel" data-test="values">
      <summary>
        <h2>Component values</h2>
        <span class="summary-count">
          {{ allValues.length }} {{ (allValues.length) === 1 ? 'value' : 'values' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">
          The valid settings of each control, extracted from the manual — a min/max pair for a
          continuous range, or one entry per position of a switch. They drive the setting controls
          when this module is used in a <RouterLink to="/patches">patch</RouterLink>; correct them
          here if the analysis got them wrong.
        </p>
        <div v-if="allValues.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Type</th>
                <th>Value</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in allValues" :key="v.id" :data-test="`value-${v.id}`">
                <td>{{ v.component.name }}</td>
                <td>{{ v.type }}</td>
                <td>{{ v.value }}</td>
                <td>{{ v.description || '—' }}</td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-value-${v.id}`"
                    @click="removeValue(v)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No values recorded for this module's components.</p>

        <form @submit.prevent="createValue">
          <div class="row">
            <div>
              <label for="value-component">Component</label>
              <select id="value-component" v-model="valueComponent" data-test="value-component">
                <option value="" disabled>Select a component…</option>
                <option v-for="c in module.components" :key="c.id" :value="c.id">
                  {{ c.name }} ({{ c.type }})
                </option>
              </select>
            </div>
            <div class="shrink">
              <label for="value-type">Type</label>
              <select id="value-type" v-model="valueType" data-test="value-type">
                <option value="enum">enum (one position)</option>
                <option value="min">min</option>
                <option value="max">max</option>
              </select>
            </div>
            <div>
              <label for="value-value">Value</label>
              <input id="value-value" v-model="valueValue" data-test="value-value" placeholder="e.g. LP or 0" />
            </div>
            <div style="flex: 2">
              <label for="value-description">Description (optional)</label>
              <input id="value-description" v-model="valueDescription" data-test="value-description" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!valueValid" data-test="value-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="valueError" class="error" data-test="value-error">{{ valueError }}</p>
        </form>
      </div>
    </details>

    <details class="panel" data-test="documents">
      <summary>
        <h2>Documents</h2>
        <span class="summary-count">
          {{ module.manuals?.length || 0 }}
          {{ module.manuals?.length === 1 ? 'document' : 'documents' }}
        </span>
      </summary>
      <div class="panel-body">
        <div v-if="module.manuals?.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>File</th>
                <th>Kind</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="doc in module.manuals" :key="doc.id" :data-test="`doc-${doc.id}`">
                <td>{{ doc.name }}</td>
                <td>
                  <a :href="`/api/manuals/${doc.hash}`" target="_blank" rel="noopener">
                    {{ doc.original_name || `${doc.hash}.pdf` }}
                  </a>
                </td>
                <td>
                  <span class="badge" :class="doc.user_id === null ? 'found' : 'pending'">
                    {{ doc.user_id === null ? 'shared manual' : 'your document' }}
                  </span>
                </td>
                <td>
                  <a
                    :href="`/api/manuals/${doc.hash}/export`"
                    :data-test="`export-doc-${doc.id}`"
                    style="margin-right: 0.6rem"
                  >
                    Export
                  </a>
                  <button
                    v-if="doc.user_id !== null"
                    class="danger"
                    style="margin: 0"
                    :data-test="`delete-doc-${doc.id}`"
                    @click="removeDocument(doc)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">No documents yet.</p>
        <label for="doc-name">Attach an additional PDF (visible only to you)</label>
        <div class="row">
          <input
            id="doc-name"
            v-model="docName"
            placeholder="Document name (not 'manual')"
            data-test="doc-name"
          />
          <input
            id="doc-upload"
            type="file"
            accept="application/pdf"
            data-test="doc-upload"
            :disabled="uploading || !docNameValid"
            @change="onFileChosen"
          />
        </div>
        <p v-if="uploadError" class="error" data-test="upload-error">{{ uploadError }}</p>
      </div>
    </details>

    <details class="panel" data-test="notes">
      <summary>
        <h2>Your notes</h2>
        <span class="summary-count">
          {{ module.notes?.length || 0 }}
          {{ module.notes?.length === 1 ? 'note' : 'notes' }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted">Notes are private to you. Manage and reuse them on the
          <RouterLink to="/notes">Notes</RouterLink> page.</p>
        <div
          v-for="note in module.notes || []"
          :key="`${note.id}-${note.component_id ?? 'm'}`"
          :data-test="`note-${note.id}-${note.component_id ?? 'module'}`"
          style="border-bottom: 1px solid var(--border); padding: 0.4rem 0"
        >
          <span class="badge" :class="note.component_id ? 'pending' : 'found'">
            {{ note.component_id ? componentName(note.component_id) : 'module' }}
          </span>
          <strong v-if="note.title"> {{ note.title }}: </strong>
          <span style="white-space: pre-wrap"> {{ note.body }}</span>
          <a href="#" :data-test="`detach-note-${note.id}-${note.component_id ?? 'module'}`" @click.prevent="detachNote(note)">✕</a>
        </div>
        <p v-if="!module.notes?.length" class="muted">No notes on this module yet.</p>

        <form @submit.prevent="createNote">
          <div class="row">
            <div>
              <label for="note-target">Attach to</label>
              <select id="note-target" v-model="noteTarget" data-test="note-target">
                <option value="module">This module</option>
                <option v-for="c in module.components || []" :key="c.id" :value="c.id">
                  {{ c.name }} ({{ c.type }})
                </option>
              </select>
            </div>
            <div style="flex: 2">
              <label for="note-body">New note</label>
              <input id="note-body" v-model="noteBody" data-test="note-body" />
            </div>
            <div class="shrink">
              <button type="submit" style="margin: 0" :disabled="!noteBody.trim()" data-test="note-create">
                Add
              </button>
            </div>
          </div>
          <p v-if="noteError" class="error" data-test="note-error">{{ noteError }}</p>
        </form>
      </div>
    </details>

    <details v-for="group in grouped" :key="group.type" class="panel" :data-test="`group-${group.type}`">
      <summary>
        <h2>{{ group.label }}</h2>
        <span class="summary-count">{{ group.components.length }}</span>
      </summary>
      <div class="panel-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th v-if="group.type.endsWith('_jack')">Connector</th>
                <th v-if="group.type.endsWith('_jack')">Voltage range</th>
                <th v-if="group.type.endsWith('_jack')">Polarity</th>
                <th v-if="group.type === 'bidirectional_jack'">Group</th>
                <th v-if="group.type === 'output_jack'">Signal</th>
                <th v-if="!group.type.endsWith('_jack')">Valid values</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in group.components" :key="c.id">
                <td>{{ c.name }}</td>
                <td>{{ c.description || '—' }}</td>
                <td v-if="group.type.endsWith('_jack')">{{ portKindLabel(c.port_kind) }}</td>
                <td v-if="group.type.endsWith('_jack')">{{ voltageRange(c) }}</td>
                <td v-if="group.type.endsWith('_jack')">{{ c.polarity || '—' }}</td>
                <td v-if="group.type === 'bidirectional_jack'">{{ c.group_label || '—' }}</td>
                <td v-if="group.type === 'output_jack'">{{ outputSignalSource(c) }}</td>
                <td v-if="!group.type.endsWith('_jack')">{{ valueSummary(c) }}</td>
                <td>
                  <template v-if="editingComponentId === c.id">
                    <select v-model="editType" :data-test="`edit-type-${c.id}`" style="width: auto">
                      <option v-for="t in COMPONENT_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                    <input
                      v-if="editType === 'bidirectional_jack'"
                      v-model="editGroup"
                      placeholder="Mult group (e.g. 1)"
                      :data-test="`edit-group-${c.id}`"
                      style="width: auto; margin-left: 0.4rem"
                    />
                    <select
                      v-if="editType.endsWith('_jack')"
                      v-model="editPortKind"
                      :data-test="`edit-port-kind-${c.id}`"
                      style="width: auto; margin-left: 0.4rem"
                    >
                      <option value="">3.5mm patch point</option>
                      <option v-for="k in PORT_KINDS" :key="k" :value="k">
                        {{ portKindLabel(k) }}
                      </option>
                    </select>
                    <button
                      style="margin: 0 0 0 0.4rem"
                      :data-test="`edit-save-${c.id}`"
                      @click="saveComponent(c)"
                    >
                      Save
                    </button>
                    <button style="margin: 0 0 0 0.4rem" @click="editingComponentId = null">
                      Cancel
                    </button>
                  </template>
                  <button
                    v-else
                    style="margin: 0"
                    :data-test="`edit-component-${c.id}`"
                    @click="startEditComponent(c)"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="editError && group.components.some((c) => c.id === editingComponentId)"
          class="error"
          data-test="edit-error"
        >
          {{ editError }}
        </p>
      </div>
    </details>

    <p v-if="module.components && module.components.length === 0" class="muted">
      No components yet — the manual hasn't been analyzed.
    </p>
  </template>
</template>
