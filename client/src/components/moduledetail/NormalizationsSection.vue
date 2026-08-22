<script setup>
import { computed, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { conditionPayload, useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName, componentLabel, jacks, controls, controlValues, conditionText } = useModuleFacts(toRef(props, 'module'));

const NORMALIZATION_KIND_LABELS = {
  input: 'from input',
  output: 'from output',
  internal: 'internal signal',
};

// Human-readable source of a normalled connection: another jack on the
// module, or an internal signal with no panel component.
function normalizationSource(n) {
  return n.source_component_id ? componentName(n.source_component_id) : n.source_label;
}

// What cancels a normalled connection, when it is not simply a cable in the
// target: Vhikk X's L output normalled to its R output breaks when a cable
// leaves L.
function breakText(n) {
  if (!n.break_component_id) return null;
  const how = n.break_on === 'cable_out' ? 'a cable out of' : 'a cable into';
  return `${how} ${componentName(n.break_component_id)}`;
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

const normValid = computed(() => {
  if (!normTarget.value || !normSource.value) return false;
  if (normConditionControl.value && !normConditionValue.value.trim()) return false;
  if (normSource.value === 'internal') return normSourceLabel.value.trim() !== '';
  return Number(normSource.value) !== Number(normTarget.value);
});

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
    await api.post(`/api/modules/${props.moduleId}/normalizations`, payload);
    normTarget.value = '';
    normSource.value = '';
    normSourceLabel.value = '';
    normDescription.value = '';
    normConditionControl.value = '';
    normConditionValue.value = '';
    normAltGroup.value = '';
    normBreakJack.value = '';
    normBreakOn.value = 'cable_in';
    emit('reload');
  } catch (e) {
    normError.value = e.message;
  }
}

async function removeNormalization(n) {
  const ok = await dialog.confirm({
    title: 'Remove normalled connection',
    message:
      `Remove the normalled connection into ${componentName(n.target_component_id)} ` +
      `from ${normalizationSource(n)}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  normError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/normalizations/${n.id}`);
    emit('reload');
  } catch (e) {
    normError.value = e.message;
  }
}
</script>

<template>
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
              <td data-label="Jack">{{ componentName(n.target_component_id) }}</td>
              <td data-label="Normalled to">{{ normalizationSource(n) }}</td>
              <td data-label="Kind">{{ NORMALIZATION_KIND_LABELS[n.kind] || n.kind }}</td>
              <td data-label="Only when" :data-test="`normalization-condition-${n.id}`">
                {{ conditionText(n) || 'always' }}
                <span v-if="n.alt_group" class="badge pending">{{ n.alt_group }}</span>
              </td>
              <td data-label="Breaks on">{{ breakText(n) || 'a cable into it' }}</td>
              <td data-label="Description">{{ n.description || '—' }}</td>
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
</template>
