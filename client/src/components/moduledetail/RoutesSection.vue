<script setup>
import { ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { conditionPayload, useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName, componentLabel, inputJacks, outputJacks, controls, controlValues, conditionText } = useModuleFacts(toRef(props, 'module'));

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
    await api.post(`/api/modules/${props.moduleId}/routes`, payload);
    routeInput.value = '';
    routeOutput.value = '';
    routeDescription.value = '';
    routeConditionControl.value = '';
    routeConditionValue.value = '';
    routeAltGroup.value = '';
    emit('reload');
  } catch (e) {
    routeError.value = e.message;
  }
}

async function removeRoute(route) {
  const ok = await dialog.confirm({
    title: 'Remove signal path',
    message:
      `Remove the internal path from ${componentName(route.input_component_id)} ` +
      `to ${componentName(route.output_component_id)}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  routeError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/routes/${route.id}`);
    emit('reload');
  } catch (e) {
    routeError.value = e.message;
  }
}
</script>

<template>
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
</template>
