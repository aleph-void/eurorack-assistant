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

const { componentName, ownJacks } = useModuleFacts(toRef(props, 'module'));

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
    await api.post(`/api/modules/${props.moduleId}/pairs`, {
      a_component_id: Number(pairA.value),
      b_component_id: Number(pairB.value),
      kind: pairKind.value.trim() || 'stereo',
    });
    pairA.value = '';
    pairB.value = '';
    emit('reload');
  } catch (e) {
    pairError.value = e.message;
  }
}

async function removePair(pair) {
  const ok = await dialog.confirm({
    title: 'Remove jack pair',
    message:
      `Stop treating ${componentName(pair.a_component_id)} and ` +
      `${componentName(pair.b_component_id)} as a ${pair.kind} pair?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  pairError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/pairs/${pair.id}`);
    emit('reload');
  } catch (e) {
    pairError.value = e.message;
  }
}
</script>

<template>
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
</template>
