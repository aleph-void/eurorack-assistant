<script setup>
// The questions asked about ONE record — a module or a patch — and the box
// that asks the next one. Asking from here is not the same as typing the
// module's name on the Ask page: the record goes into the question's scope as
// it is created (`module_ids`/`patch_ids` on POST /api/questions), so the
// answer is about this module even when the wording never names it ("why is
// this so quiet?"), and a patch brings its cables and settings with it.
//
// A MODULE names its own scope, so nothing has to be worked out from the
// wording: no scoping pass runs at all, and the question is 'scoped' the
// moment it exists. That is also why the components are offered HERE rather
// than left to a model — the asker knows which jack or knob they mean, and
// ticking it (`component_ids`) puts it in scope before the question is saved.
//
// Both pages are the same list of the same records, so they are one panel:
// only the word for the thing and the query key differ.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { COMPONENT_TYPES, TYPE_LABELS } from '../componentTypes.js';
import { useLazyPanel } from '../lazyPanel.js';

const props = defineProps({
  // 'module' or 'patch' — the query key, the payload key and the wording.
  kind: { type: String, required: true },
  recordId: { type: String, required: true },
  // A module's own components, so the asker can say which of them the
  // question is about. Unused for a patch.
  components: { type: Array, default: () => [] },
});

const router = useRouter();
const questions = ref([]);
const loading = ref(true);
const listError = ref('');
const prompt = ref('');
const askError = ref('');
const busy = ref(false);
const selectedComponents = ref([]);
// Built the first time it is opened (lazyPanel.js).
const { opened: partsOpened, onToggle: onPartsToggle } = useLazyPanel();

const noun = computed(() => (props.kind === 'patch' ? 'patch' : 'module'));

// The module's components in the house order, one group per type, so a jack
// is picked out of the jacks rather than out of a list of everything.
const componentGroups = computed(() => {
  if (noun.value !== 'module') return [];
  return COMPONENT_TYPES.map((type) => ({
    type,
    label: TYPE_LABELS[type],
    items: props.components.filter((c) => c.type === type),
  })).filter((group) => group.items.length > 0);
});

async function load() {
  loading.value = true;
  listError.value = '';
  try {
    questions.value = await api.get(`/api/questions?${noun.value}_id=${props.recordId}`);
  } catch (e) {
    listError.value = e.message;
    questions.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(
  () => props.recordId,
  () => {
    selectedComponents.value = [];
    load();
  }
);

// Only components of the record on screen: a stale tick from a module that
// has just been swapped under the panel would be refused by the server.
const chosenComponentIds = computed(() =>
  props.components.filter((c) => selectedComponents.value.includes(c.id)).map((c) => c.id)
);

function selectAllComponents() {
  selectedComponents.value = props.components.map((c) => c.id);
}

async function ask() {
  askError.value = '';
  busy.value = true;
  try {
    const body = {
      prompt: prompt.value,
      [`${noun.value}_ids`]: [Number(props.recordId)],
    };
    if (noun.value === 'module') body.component_ids = chosenComponentIds.value;
    const question = await api.post('/api/questions', body);
    router.push({ name: 'question-detail', params: { id: question.id } });
  } catch (e) {
    askError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '';
}
</script>

<template>
  <details open class="panel" data-test="record-questions">
    <summary>
      <h2>Questions</h2>
      <span class="summary-count">
        {{ questions.length }} {{ questions.length === 1 ? 'question' : 'questions' }}
      </span>
    </summary>
    <div class="panel-body">
      <form @submit.prevent="ask">
        <label :for="`ask-${noun}`">Ask about this {{ noun }}</label>
        <textarea
          :id="`ask-${noun}`"
          v-model="prompt"
          data-test="ask-prompt"
          :placeholder="
            noun === 'patch'
              ? 'e.g. Why is the bass line dropping out every fourth bar?'
              : 'e.g. How do I get a slow rise and a fast fall out of it?'
          "
        ></textarea>

        <details
          v-if="componentGroups.length > 0"
          class="expander"
          data-test="ask-components"
          @toggle="onPartsToggle"
        >
          <summary>
            <h3>Which parts of it?</h3>
            <span class="summary-count">
              {{ chosenComponentIds.length }} of {{ components.length }}
            </span>
          </summary>
          <div v-if="partsOpened" class="expander-body">
            <p class="muted">
              Optional. Tick the jacks, knobs and switches the question is about and they go
              into its scope with the module.
            </p>
            <div class="actions">
              <button
                type="button"
                class="secondary"
                data-test="components-all"
                @click="selectAllComponents"
              >
                Select all
              </button>
              <button
                type="button"
                class="secondary"
                data-test="components-none"
                :disabled="selectedComponents.length === 0"
                @click="selectedComponents = []"
              >
                Clear
              </button>
            </div>
            <div v-for="group in componentGroups" :key="group.type" class="component-group">
              <h4>{{ group.label }}</h4>
              <ul class="check-list">
                <li v-for="c in group.items" :key="c.id">
                  <label>
                    <input
                      v-model="selectedComponents"
                      type="checkbox"
                      :value="c.id"
                      data-test="ask-component-option"
                    />
                    <span>{{ c.name }}</span>
                  </label>
                </li>
              </ul>
            </div>
          </div>
        </details>

        <p class="muted">
          <template v-if="noun === 'patch'">
            This patch is in the question's scope from the start, with its cables, control
            settings and signal flow attached. You still review the scope — adding modules,
            documents, notes and previous answers — before the answer is generated.
          </template>
          <template v-else>
            This module — and any parts of it you tick — is the question's scope, so nothing has
            to guess at it from the wording. You go straight to the review step, where you can
            add other modules and attach documents, notes and previous answers before the answer
            is generated.
          </template>
        </p>
        <p v-if="askError" class="error" data-test="ask-error">{{ askError }}</p>
        <button type="submit" :disabled="busy || !prompt.trim()" data-test="ask-submit">Ask</button>
      </form>

      <p v-if="listError" class="error" data-test="questions-error">{{ listError }}</p>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="questions.length === 0" class="muted" data-test="no-questions">
        No questions about this {{ noun }} yet.
      </p>
      <div v-else class="table-wrap">
        <table data-test="record-question-table">
          <thead>
            <tr>
              <th>Question</th>
              <th>Status</th>
              <th>Asked</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in questions" :key="q.id">
              <td data-label="Question">
                <RouterLink :to="`/questions/${q.id}`">{{ q.prompt }}</RouterLink>
              </td>
              <td data-label="Status"><span class="badge" :class="q.status">{{ q.status }}</span></td>
              <td data-label="Asked" class="muted">{{ formatDate(q.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted">
        Every question you have asked is on the <RouterLink to="/questions">Questions</RouterLink>
        page, where they can also be shared and deleted.
      </p>
    </div>
  </details>
</template>

<style scoped>
.component-group + .component-group {
  margin-top: 0.75rem;
}

.component-group h4 {
  margin: 0 0 0.25rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
</style>
