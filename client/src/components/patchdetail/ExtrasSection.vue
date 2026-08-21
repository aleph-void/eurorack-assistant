<script setup>
import { computed, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import AutocompleteSelect from '../AutocompleteSelect.vue';
import { jackLabel, portKindLabel, usePatchFacts } from './usePatchFacts.js';
import { useLazyPanel } from '../../lazyPanel.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
  rackModules: { type: Array, default: () => [] },
});
const emit = defineEmits(['reload']);

// Built the first time it is opened (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const { modules, moduleLabel } = usePatchFacts(toRef(props, 'patch'));

// ---- extra instances: more modules, borrowed modules, off-rack gear ----
const addKind = ref('rack'); // 'rack' | 'other' | 'external'
const addModuleId = ref('');
const addManufacturer = ref('');
const addName = ref('');
const addLabel = ref('');
const addError = ref('');

const rackModuleOptions = computed(() =>
  props.rackModules.map((m) => ({ value: m.id, label: `${m.manufacturer} ${m.name}`.trim() }))
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
    await api.post(`/api/patches/${props.patchId}/modules`, body);
    addModuleId.value = '';
    addManufacturer.value = '';
    addName.value = '';
    addLabel.value = '';
    emit('reload');
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
    await api.post(`/api/patches/${props.patchId}/modules/${portModuleId.value}/ports`, {
      name: portName.value.trim(),
      type: portType.value,
      port_kind: portKind.value || undefined,
    });
    portName.value = '';
    emit('reload');
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
    await api.delete(`/api/patches/${props.patchId}/modules/${pm.id}/ports/${port.id}`);
    emit('reload');
  } catch (e) {
    portError.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="extras" @toggle="onToggle">
    <summary>
      <h2>Other gear in this patch</h2>
      <span class="summary-count">
        {{ declaredModules.length }} {{ (declaredModules.length) === 1 ? 'item' : 'items' }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
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
</template>
