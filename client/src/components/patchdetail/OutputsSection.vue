<script setup>
// Where sound leaves the system, as THIS patch keeps it: copied from the
// racks when the patch was made, edited here since — a patch of a travelling
// case has different exits from the studio's, and gear declared inside the
// patch (the interface, the PA) is an exit no rack knows about. Each one
// says whether the traced flow reaches it, which is the first thing to
// check when a patch is silent.
import { computed, ref, toRef, watch } from 'vue';
import { api } from '../../api.js';
import { isPatchPoint, usePatchFacts } from './usePatchFacts.js';
import { useLazyPanel } from '../../lazyPanel.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { opened, onToggle } = useLazyPanel();
const { modules, modulesById, moduleLabel } = usePatchFacts(toRef(props, 'patch'));

const outputs = computed(() => props.patch?.outputs ?? []);
const reachedCount = computed(() => outputs.value.filter((o) => o.reached).length);

const moduleId = ref('');
const componentId = ref('');
const error = ref('');
const jacks = computed(() => {
  const pm = modulesById.value.get(Number(moduleId.value));
  return (pm?.components ?? []).filter((c) => String(c.type).endsWith('_jack') && isPatchPoint(c));
});
watch(moduleId, () => {
  componentId.value = '';
});

async function add() {
  error.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/outputs`, {
      patch_module_id: Number(moduleId.value),
      component_id: Number(componentId.value),
    });
    componentId.value = '';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(output) {
  error.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/outputs/${output.id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="outputs" @toggle="onToggle">
    <summary>
      <h2>Where sound leaves</h2>
      <span class="summary-count" data-test="outputs-count">
        {{ outputs.length }} {{ outputs.length === 1 ? 'output' : 'outputs' }}{{
          outputs.length ? `, ${reachedCount} reached` : ''
        }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
      <p class="muted">
        The jacks this patch's sound is meant to come out of, copied from the rack when the patch was
        made. The model builds a generated patch towards them, and each one says whether the traced
        signal flow actually gets there. Gear declared on this patch — the interface, the PA — can be
        an exit too.
      </p>
      <p v-if="error" class="error" data-test="outputs-error">{{ error }}</p>
      <div v-if="outputs.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>Jack</th>
              <th>Signal</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="output in outputs" :key="output.id" :data-test="`output-${output.id}`">
              <td data-label="Module">{{ moduleLabel(output.patch_module_id) }}</td>
              <td data-label="Jack">
                {{ output.component_name }}
                <span v-if="!output.live" class="muted">(no longer on the module)</span>
              </td>
              <td data-label="Signal">
                <span
                  class="badge"
                  :class="output.reached ? 'found' : 'failed'"
                  :data-test="`output-reached-${output.id}`"
                >
                  {{ output.reached ? 'reaches it' : 'nothing reaches it' }}
                </span>
              </td>
              <td class="actions-cell">
                <button
                  class="danger small"
                  :data-test="`remove-output-${output.id}`"
                  @click="remove(output)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted" data-test="outputs-empty">
        No output is marked on this patch. Mark the rack's outputs on the racks page for every new
        patch to start with them, or add one here.
      </p>
      <form class="row" @submit.prevent="add">
        <div>
          <select v-model="moduleId" data-test="output-module" aria-label="Module">
            <option value="" disabled>Module…</option>
            <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm.id) }}</option>
          </select>
        </div>
        <div>
          <select v-model="componentId" data-test="output-jack" aria-label="Jack" :disabled="!moduleId">
            <option value="" disabled>Jack…</option>
            <option v-for="jack in jacks" :key="jack.id" :value="jack.id">{{ jack.name }}</option>
          </select>
        </div>
        <div class="shrink">
          <button type="submit" style="margin: 0" :disabled="!moduleId || !componentId" data-test="add-output">
            Mark as output
          </button>
        </div>
      </form>
    </div>
  </details>
</template>
