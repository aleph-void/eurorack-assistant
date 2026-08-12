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

// "Make Noise Maths", plus "#2" when the rack held several of the module.
function moduleLabel(pm) {
  if (!pm) return '(removed module)';
  const twins = modules.value.filter((m) => m.module_id === pm.module_id).length;
  const base = `${pm.manufacturer} ${pm.module_name}`.trim();
  return twins > 1 ? `${base} #${pm.instance}` : base;
}

// Type-to-find: narrow the module dropdowns by manufacturer or module name.
function matchesFilter(pm, filter) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return `${pm.manufacturer} ${pm.module_name}`.toLowerCase().includes(needle);
}

// A mult's bidirectional jacks can sit at either end of a cable: plugging
// into one makes it the group's input, the rest carry copies out.
const FROM_TYPES = ['output_jack', 'bidirectional_jack'];
const TO_TYPES = ['input_jack', 'bidirectional_jack'];

function jackLabel(c) {
  if (c.type !== 'bidirectional_jack') return c.name;
  return `${c.name} (mult${c.group_label ? ` ${c.group_label}` : ''})`;
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

async function addCable() {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.id}/cables`, {
      from_patch_module_id: Number(fromModuleId.value),
      from_component_id: Number(fromComponentId.value),
      to_patch_module_id: Number(toModuleId.value),
      to_component_id: Number(toComponentId.value),
    });
    fromComponentId.value = '';
    toComponentId.value = '';
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
  const options = component.values.filter((v) => v.type === 'enum');
  if (options.length > 0) return { kind: 'enum', options };
  const min = component.values.find((v) => v.type === 'min')?.value;
  const max = component.values.find((v) => v.type === 'max')?.value;
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
// Server-traced: each normalization is active until a cable lands in its
// target, and its signals array names what actually arrives (following
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
  if (!n.active) return 'a cable is patched into the input';
  return `receives ${n.signals.map(signalText).join('; ')}`;
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

function flowNodeText(node) {
  return `${moduleLabel(modulesById.value.get(node.patch_module_id))} — ${node.name}`;
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
              <button
                class="danger"
                style="margin: 0"
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
            placeholder="Filter by manufacturer or module name…"
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
        <p v-if="cableError" class="error" data-test="cable-error">{{ cableError }}</p>
      </form>
    </div>

    <div v-if="patch.flow?.length" class="panel" data-test="flow">
      <h2>Signal flow</h2>
      <p class="muted">
        Every signal source in the patch — generator outputs (which no internal path feeds) and
        internal normalled signals — traced through cables, mult copies, normalled connections
        and each module's internal signal paths to everywhere it goes. Splits show as branches;
        merges, switch positions (only one is live at a time) and feedback loops are flagged.
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
        <span v-if="row.depth === 0" class="badge found">
          {{ row.node.kind === 'internal' ? 'internal source' : 'generator' }}
        </span>
        <span v-if="row.node.switched" class="badge pending">one switch position</span>
        <span v-if="row.node.merge" class="badge pending">merge point</span>
        <span v-if="row.node.switched_merge" class="badge pending">switched — one source at a time</span>
        <span v-if="row.node.cycle" class="badge failed">feedback loop ↺</span>
      </div>
    </div>

    <div v-if="patch.normalizations?.length" class="panel" data-test="normalled">
      <h2>Normalled connections in this patch</h2>
      <p class="muted">
        Built-in default connections. Each one stays active until a cable is patched into its
        target input; chained normals are traced to the signal that actually arrives.
      </p>
      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>Input</th>
            <th>Normalled to</th>
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

    <div class="panel" data-test="snapshot">
      <h2>Modules in this patch</h2>
      <table>
        <thead>
          <tr>
            <th>Module</th>
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
            <td>
              <span class="badge" :class="pm.live ? 'found' : 'failed'">
                {{ pm.live ? 'in your system' : 'no longer in your system' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
