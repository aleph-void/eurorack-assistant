<script setup>
import { ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
  candidates: { type: Array, default: () => [] },
});
const emit = defineEmits(['reload']);

// ---- expander panels ----
// Two modules joined by a ribbon cable that behave as one instrument. Once
// linked, this module's signal paths may reach the expander's jacks.
const expanderTarget = ref('');
const expanderError = ref('');

async function createExpander() {
  expanderError.value = '';
  try {
    await api.post(`/api/modules/${props.moduleId}/expanders`, {
      expander_module_id: Number(expanderTarget.value),
    });
    expanderTarget.value = '';
    emit('reload');
  } catch (e) {
    expanderError.value = e.message;
  }
}

async function removeExpander(link) {
  const ok = await dialog.confirm({
    title: 'Unlink expander',
    message:
      `Unlink ${[link.manufacturer, link.name].filter(Boolean).join(' ') || 'this expander'}? ` +
      'The two modules stop being treated as one instrument.',
    confirmLabel: 'Unlink',
    danger: true,
  });
  if (!ok) return;
  expanderError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/expanders/${link.id}`);
    emit('reload');
  } catch (e) {
    expanderError.value = e.message;
  }
}
</script>

<template>
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
              <option v-for="m in candidates" :key="m.id" :value="m.id">
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
</template>
