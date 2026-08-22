<script setup>
import { computed, ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
  candidates: { type: Array, default: () => [] },
});
const emit = defineEmits(['reload']);

// ---- dual modules ----
// Two panels of ONE product joined by a link cable rather than by patch
// cables (Omnitone 7Path's ethernet pair). Neither panel is the host: jack N
// of one is wired to jack N of the other, and whichever end a cable goes into
// is that wire's input.
const bridges = computed(() => props.module.bridges || []);
const quantity = computed(() =>
  (props.module.racks || []).reduce((sum, r) => sum + (r.quantity || 0), 0)
);
// A dual racked as one record with two copies is its own other half.
const selfPossible = computed(
  () => quantity.value >= 2 && !bridges.value.some((b) => b.self)
);
const bridgeTarget = ref('');
const bridgeError = ref('');

async function createBridge() {
  bridgeError.value = '';
  try {
    await api.post(`/api/modules/${props.moduleId}/bridges`, {
      bridge_module_id: Number(bridgeTarget.value),
    });
    bridgeTarget.value = '';
    emit('reload');
  } catch (e) {
    bridgeError.value = e.message;
  }
}

async function removeBridge(bridge) {
  const ok = await dialog.confirm({
    title: 'Unlink dual panels',
    message:
      'Stop treating these two panels as one dual module? Patches already built keep the ' +
      'pair they were built with; new ones will not wire it up.',
    confirmLabel: 'Unlink',
    danger: true,
  });
  if (!ok) return;
  bridgeError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/bridges/${bridge.id}`);
    emit('reload');
  } catch (e) {
    bridgeError.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="bridges">
    <summary>
      <h2>Dual panels</h2>
      <span class="summary-count">
        {{ bridges.length }} {{ bridges.length === 1 ? 'pair' : 'pairs' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Two panels of one product joined by a link cable rather than by patch cables — an
        Omnitone 7Path pair and its ethernet lead. Jack by jack, the two panels are the two ends
        of one wire: whichever end you patch into is that wire's input, and the matching jack on
        the OTHER panel is where the signal comes out. Declared here once, every patch built from
        your racks wires the pair up on its own.
      </p>
      <div v-if="bridges.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Other panel</th>
              <th>Wires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bridges" :key="b.id" :data-test="`bridge-${b.id}`">
              <td data-label="Other panel">
                <template v-if="b.self">a second copy of this module</template>
                <RouterLink v-else-if="b.module_id" :to="`/modules/${b.module_id}`">
                  {{ b.manufacturer }} {{ b.name }}
                </RouterLink>
              </td>
              <td data-label="Wires">
                {{ b.jacks?.length ? `${b.jacks.length} paired by hand` : 'paired by jack name' }}
              </td>
              <td>
                <button
                  class="danger"
                  style="margin: 0"
                  :data-test="`delete-bridge-${b.id}`"
                  @click="removeBridge(b)"
                >
                  Unlink
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">This module is not half of a dual.</p>

      <form @submit.prevent="createBridge">
        <div class="row">
          <div>
            <label for="bridge-target">Link the other panel</label>
            <select id="bridge-target" v-model="bridgeTarget" data-test="bridge-target">
              <option value="" disabled>Select a module…</option>
              <option v-if="selfPossible" :value="Number(moduleId)">
                A second copy of this module
              </option>
              <option v-for="m in candidates" :key="m.id" :value="m.id">
                {{ m.manufacturer }} {{ m.name }}
              </option>
            </select>
          </div>
          <div class="shrink">
            <button
              type="submit"
              style="margin: 0"
              :disabled="!bridgeTarget"
              data-test="bridge-create"
            >
              Link
            </button>
          </div>
        </div>
        <p v-if="bridgeError" class="error" data-test="bridge-error">{{ bridgeError }}</p>
      </form>
    </div>
  </details>
</template>
