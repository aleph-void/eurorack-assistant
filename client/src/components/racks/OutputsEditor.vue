<script setup>
// Where sound leaves: the jacks that feed the speakers, the interface, the
// mixer on the desk. A fact about the studio rather than the module, so it is
// kept on the SYSTEM — a studio of several cases has one set of exits — and
// on a rack only while that rack stands alone. Every patch takes its own copy
// of whichever list it was made from. The generator builds towards these and
// the flow page says whether a patch reaches one.
//
// One editor for both: `kind` says which record `recordId` is. A rack that is
// part of a system (`systemName`) shows the exits it had and points at the
// system, where the ones its patches now use are marked.
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api.js';
import { isPatchPoint } from '../../panelLayout.js';

const props = defineProps({
  kind: { type: String, default: 'rack', validator: (v) => v === 'rack' || v === 'system' },
  recordId: { type: Number, required: true },
  systemName: { type: String, default: '' },
});

const base = computed(() => `/api/${props.kind === 'system' ? 'systems' : 'racks'}/${props.recordId}`);
const readOnly = computed(() => props.kind === 'rack' && !!props.systemName);

const outputs = ref([]);
// Every module the exits may be marked on, with the rack it stands in: a
// system may hold the same module in two cases, and only one of them is wired
// out, so a choice is a (rack, module) pair.
const choices = ref([]);
const error = ref('');
const loading = ref(true);

// The picker: a module, then one of its jacks (read off the module record the
// first time that module is picked).
const choiceKey = ref('');
const componentId = ref('');
const jacksByModule = ref(new Map());
const chosen = computed(() => choices.value.find((c) => c.key === choiceKey.value) ?? null);
const jacks = computed(() => (chosen.value ? jacksByModule.value.get(chosen.value.moduleId) ?? [] : []));

function choicesOf(record) {
  const racks = props.kind === 'system' ? record.racks ?? [] : [record];
  const named = racks.length > 1;
  return racks.flatMap((rack) =>
    (rack.modules ?? []).map((module) => ({
      key: `${rack.id}:${module.id}`,
      rackId: rack.id,
      moduleId: module.id,
      label: `${module.manufacturer} ${module.name}${named ? ` (${rack.name})` : ''}`,
    }))
  );
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const record = await api.get(base.value);
    outputs.value = record.outputs ?? [];
    choices.value = choicesOf(record);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(base, load);

watch(choiceKey, async () => {
  componentId.value = '';
  const key = chosen.value?.moduleId;
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
  const body = { module_id: chosen.value.moduleId, component_id: Number(componentId.value) };
  if (props.kind === 'system') body.rack_id = chosen.value.rackId;
  try {
    const res = await api.post(`${base.value}/outputs`, body);
    outputs.value = res.outputs ?? [];
    componentId.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(output) {
  error.value = '';
  try {
    const res = await api.delete(`${base.value}/outputs/${output.id}`);
    outputs.value = res.outputs ?? [];
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="rack-outputs">
    <p v-if="readOnly" class="muted" data-test="outputs-in-system">
      This rack is part of <strong>{{ systemName }}</strong>, and a patch of the system builds towards
      the system's outputs — mark them on <RouterLink to="/systems">Systems</RouterLink>, with the
      system's Outputs button. The ones below are what this rack goes back to if it leaves.
    </p>
    <p v-else-if="kind === 'system'" class="muted">
      The jacks sound leaves the system at — the input of an output module, a mixer's main out, the
      jack a cable runs to the interface from — in whichever rack they stand. A new patch of the
      system copies them, the model builds a generated patch towards them, and the flow page says
      whether a patch reaches one.
    </p>
    <p v-else class="muted">
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
          <span v-if="output.rack_name" class="muted">in {{ output.rack_name }}</span>
          <button
            v-if="!readOnly"
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
      <form v-if="!readOnly" class="row" @submit.prevent="add">
        <div>
          <select v-model="choiceKey" data-test="rack-output-module" aria-label="Module">
            <option value="" disabled>Module…</option>
            <option v-for="choice in choices" :key="choice.key" :value="choice.key">
              {{ choice.label }}
            </option>
          </select>
        </div>
        <div>
          <select
            v-model="componentId"
            data-test="rack-output-jack"
            aria-label="Jack"
            :disabled="!chosen"
          >
            <option value="" disabled>
              {{ chosen && jacks.length === 0 ? 'No jacks analyzed yet' : 'Jack…' }}
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
            :disabled="!chosen || !componentId"
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
