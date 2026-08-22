<script setup>
import { computed, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName, jacks } = useModuleFacts(toRef(props, 'module'));

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
    await api.post(`/api/modules/${props.moduleId}/switches`, {
      common_component_id: Number(switchCommon.value),
      step_component_ids: switchSteps.value
        .map(Number)
        .filter((id) => id !== Number(switchCommon.value)),
      name: switchName.value.trim() || undefined,
    });
    switchCommon.value = '';
    switchSteps.value = [];
    switchName.value = '';
    emit('reload');
  } catch (e) {
    switchError.value = e.message;
  }
}

async function removeSwitch(section) {
  const ok = await dialog.confirm({
    title: 'Remove routing switch',
    message: `Remove ${section.name || `switch ${section.id}`} and the steps recorded for it?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  switchError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/switches/${section.id}`);
    emit('reload');
  } catch (e) {
    switchError.value = e.message;
  }
}
</script>

<template>
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
              <td data-label="Section">{{ s.name || `Switch ${s.id}` }}</td>
              <td data-label="Common">{{ componentName(s.common_component_id) }}</td>
              <td data-label="Steps">{{ s.step_component_ids.map(componentName).join(', ') }}</td>
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
</template>
