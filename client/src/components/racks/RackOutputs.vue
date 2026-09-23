<script setup>
// Where sound leaves a rack: the jacks that feed the speakers, the interface,
// the mixer on the desk. A fact about the studio rather than the module, so
// it is kept on the rack (module records are shared), and every patch made
// of the rack takes its own copy. The generator builds towards these and
// the flow page says whether a patch reaches one.
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../../api.js';
import { isPatchPoint } from '../../panelLayout.js';

const props = defineProps({
  rackId: { type: Number, required: true },
  rackName: { type: String, default: '' },
});

const outputs = ref([]);
const modules = ref([]);
const error = ref('');
const loading = ref(true);

// The picker: a module of the rack, then one of its jacks (read off the
// module record the first time that module is picked).
const moduleId = ref('');
const componentId = ref('');
const jacksByModule = ref(new Map());
const jacks = computed(() => jacksByModule.value.get(Number(moduleId.value)) ?? []);

async function load() {
  loading.value = true;
  try {
    const rack = await api.get(`/api/racks/${props.rackId}`);
    outputs.value = rack.outputs ?? [];
    modules.value = rack.modules ?? [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => props.rackId, load);

watch(moduleId, async (id) => {
  componentId.value = '';
  const key = Number(id);
  if (!key || jacksByModule.value.has(key)) return;
  try {
    const module = await api.get(`/api/modules/${key}`, { quiet: true });
    const list = (module.components ?? []).filter(
      (c) => String(c.type).endsWith('_jack') && isPatchPoint(c)
    );
    jacksByModule.value = new Map(jacksByModule.value).set(key, list);
  } catch {
    jacksByModule.value = new Map(jacksByModule.value).set(key, []);
  }
});

async function add() {
  error.value = '';
  try {
    const res = await api.post(`/api/racks/${props.rackId}/outputs`, {
      module_id: Number(moduleId.value),
      component_id: Number(componentId.value),
    });
    outputs.value = res.outputs ?? [];
    componentId.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(output) {
  error.value = '';
  try {
    const res = await api.delete(`/api/racks/${props.rackId}/outputs/${output.id}`);
    outputs.value = res.outputs ?? [];
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="rack-outputs">
    <p class="muted">
      The jacks sound leaves this rack at — the input of an output module, a mixer's main out, the
      jack a cable runs to the interface from. A new patch of the rack copies them, the model builds
      a generated patch towards them, and the flow page says whether a patch reaches one.
    </p>
    <p v-if="error" class="error" data-test="rack-outputs-error">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <ul v-if="outputs.length" class="output-list" data-test="rack-output-list">
        <li v-for="output in outputs" :key="output.id" :data-test="`rack-output-${output.id}`">
          {{ output.manufacturer }} {{ output.module_name }} — {{ output.component_name }}
          <button
            class="secondary small"
            :data-test="`remove-rack-output-${output.id}`"
            @click="remove(output)"
          >
            Remove
          </button>
        </li>
      </ul>
      <p v-else class="muted" data-test="rack-outputs-empty">
        No output marked yet — until one is, a generated patch can only guess where sound leaves.
      </p>
      <form class="row" @submit.prevent="add">
        <div>
          <select v-model="moduleId" data-test="rack-output-module" aria-label="Module">
            <option value="" disabled>Module…</option>
            <option v-for="module in modules" :key="module.id" :value="module.id">
              {{ module.manufacturer }} {{ module.name }}
            </option>
          </select>
        </div>
        <div>
          <select
            v-model="componentId"
            data-test="rack-output-jack"
            aria-label="Jack"
            :disabled="!moduleId"
          >
            <option value="" disabled>
              {{ moduleId && jacks.length === 0 ? 'No jacks analyzed yet' : 'Jack…' }}
            </option>
            <option v-for="jack in jacks" :key="jack.id" :value="jack.id">
              {{ jack.name }} ({{ jack.type.replace(/_jack$/, '') }})
            </option>
          </select>
        </div>
        <div class="shrink">
          <button
            type="submit"
            style="margin: 0"
            :disabled="!moduleId || !componentId"
            data-test="add-rack-output"
          >
            Mark as output
          </button>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.output-list {
  list-style: none;
  padding: 0;
  margin: 0 0 0.75rem;
}

.output-list li {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.25rem 0;
}
</style>
