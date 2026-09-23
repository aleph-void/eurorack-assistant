<script setup>
// Where sound leaves: the MODULES that feed the speakers, the interface, the
// mixer on the desk — each with the jacks of it in use if you care to say,
// none meaning the module as a whole. A fact about the studio rather than the
// module, so it is kept on the SYSTEM — a studio of several cases has one set
// of exits — and on a rack only while that rack stands alone. Every patch
// takes its own copy of whichever list it was made from. The generator builds
// towards these and the flow page says whether a patch reaches one.
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

const EXIT_JACK_TYPES = ['input_jack', 'bidirectional_jack'];

const base = computed(() => `/api/${props.kind === 'system' ? 'systems' : 'racks'}/${props.recordId}`);
const readOnly = computed(() => props.kind === 'rack' && !!props.systemName);

const outputs = ref([]);
// Every module an exit may be marked on, with the rack it stands in: a system
// may hold the same module in two cases, and only one of them is wired out,
// so a choice is a (rack, module) pair.
const choices = ref([]);
const error = ref('');
const loading = ref(true);

// The jacks of each module sound can leave by — an input, or a jack that is
// either, never an output (nothing is patched into one) — and that a cable
// can reach, read off the module record the first time they are wanted.
const jacksByModule = ref(new Map());
const jacksOf = (moduleId) => jacksByModule.value.get(moduleId) ?? [];
async function loadJacks(moduleId) {
  if (!moduleId || jacksByModule.value.has(moduleId)) return;
  try {
    const module = await api.get(`/api/modules/${moduleId}`, { quiet: true });
    const list = (module.components ?? []).filter(
      (c) => EXIT_JACK_TYPES.includes(c.type) && isPatchPoint(c)
    );
    jacksByModule.value = new Map(jacksByModule.value).set(moduleId, list);
  } catch {
    jacksByModule.value = new Map(jacksByModule.value).set(moduleId, []);
  }
}

// The picker: a module, then — if you like — the jacks of it in use.
const choiceKey = ref('');
const picked = ref([]);
const chosen = computed(() => choices.value.find((c) => c.key === choiceKey.value) ?? null);
const markedKeys = computed(() => new Set(outputs.value.map((o) => `${o.rack_id}:${o.module_id}`)));

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

watch(choiceKey, () => {
  picked.value = [];
  loadJacks(chosen.value?.moduleId);
});

async function add() {
  error.value = '';
  const body = { module_id: chosen.value.moduleId, component_ids: picked.value.map(Number) };
  if (props.kind === 'system') body.rack_id = chosen.value.rackId;
  try {
    const res = await api.post(`${base.value}/outputs`, body);
    outputs.value = res.outputs ?? [];
    choiceKey.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

// Changing which jacks of a marked module are in use, all of them at once.
const editingId = ref(null);
const editing = ref([]);
function startEdit(output) {
  editingId.value = output.id;
  editing.value = output.jacks.map((j) => j.component_id);
  loadJacks(output.module_id);
}
async function saveJacks(output) {
  error.value = '';
  try {
    const res = await api.put(`${base.value}/outputs/${output.id}`, {
      component_ids: editing.value.map(Number),
    });
    outputs.value = res.outputs ?? [];
    editingId.value = null;
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(output) {
  error.value = '';
  try {
    const res = await api.delete(`${base.value}/outputs/${output.id}`);
    outputs.value = res.outputs ?? [];
    if (editingId.value === output.id) editingId.value = null;
  } catch (e) {
    error.value = e.message;
  }
}

const jackText = (output) =>
  output.jacks.length ? output.jacks.map((j) => j.component_name).join(', ') : 'the whole module';
</script>

<template>
  <div class="rack-outputs">
    <p v-if="readOnly" class="muted" data-test="outputs-in-system">
      This rack is part of <strong>{{ systemName }}</strong>, and a patch of the system builds towards
      the system's outputs — mark them on <RouterLink to="/systems">Systems</RouterLink>, with the
      system's Outputs button. The ones below are what this rack goes back to if it leaves.
    </p>
    <p v-else class="muted">
      The modules sound leaves {{ kind === 'system' ? 'the system' : 'this rack' }} at — an output
      module, a mixer, the interface's inputs. Say which of their jacks are in use if you like; if you
      don't, the whole module counts. A new patch copies them, the model builds a generated patch
      towards them, and the flow page says whether a patch reaches one.
    </p>
    <p v-if="error" class="error" data-test="rack-outputs-error">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <ul v-if="outputs.length" class="output-list" data-test="rack-output-list">
        <li v-for="output in outputs" :key="output.id" :data-test="`rack-output-${output.id}`">
          <div class="output-line">
            <span>
              {{ output.manufacturer }} {{ output.module_name
              }}<span v-if="output.rack_name" class="muted"> in {{ output.rack_name }}</span>
              — <span :class="{ muted: !output.jacks.length }">{{ jackText(output) }}</span>
            </span>
            <template v-if="!readOnly">
              <button
                class="secondary small"
                :data-test="`edit-rack-output-${output.id}`"
                @click="editingId === output.id ? (editingId = null) : startEdit(output)"
              >
                {{ editingId === output.id ? 'Cancel' : 'Jacks' }}
              </button>
              <button
                class="secondary small"
                :data-test="`remove-rack-output-${output.id}`"
                @click="remove(output)"
              >
                Remove
              </button>
            </template>
          </div>
          <form
            v-if="editingId === output.id"
            class="jack-picks"
            :data-test="`rack-output-edit-${output.id}`"
            @submit.prevent="saveJacks(output)"
          >
            <span v-if="jacksOf(output.module_id).length === 0" class="muted">No jacks analyzed yet.</span>
            <label v-for="jack in jacksOf(output.module_id)" :key="jack.id" class="jack-pick">
              <input
                v-model="editing"
                type="checkbox"
                :value="jack.id"
                :data-test="`rack-output-edit-jack-${jack.id}`"
              />
              {{ jack.name }} ({{ jack.type.replace(/_jack$/, '') }})
            </label>
            <button type="submit" class="small" :data-test="`save-rack-output-${output.id}`">Save</button>
          </form>
        </li>
      </ul>
      <p v-else class="muted" data-test="rack-outputs-empty">
        No output marked yet — until one is, a generated patch can only guess where sound leaves.
      </p>
      <form v-if="!readOnly" @submit.prevent="add">
        <div class="row">
          <div>
            <select v-model="choiceKey" data-test="rack-output-module" aria-label="Module">
              <option value="" disabled>Module…</option>
              <option
                v-for="choice in choices"
                :key="choice.key"
                :value="choice.key"
                :disabled="markedKeys.has(choice.key)"
              >
                {{ choice.label }}
              </option>
            </select>
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!chosen" data-test="add-rack-output">
              Mark as output
            </button>
          </div>
        </div>
        <div v-if="chosen" class="jack-picks" data-test="rack-output-jacks">
          <span class="muted">Jacks in use (optional):</span>
          <span v-if="jacksOf(chosen.moduleId).length === 0" class="muted">none analyzed yet</span>
          <label v-for="jack in jacksOf(chosen.moduleId)" :key="jack.id" class="jack-pick">
            <input v-model="picked" type="checkbox" :value="jack.id" :data-test="`rack-output-jack-${jack.id}`" />
            {{ jack.name }} ({{ jack.type.replace(/_jack$/, '') }})
          </label>
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
  padding: 0.25rem 0;
}

.output-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}

.jack-picks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 1rem;
  margin: 0.4rem 0 0.6rem;
}

.jack-pick {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin: 0;
  font-weight: normal;
}

.jack-pick input {
  width: auto;
  margin: 0;
}
</style>
