<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const question = ref(null);
const options = ref(null);
const error = ref('');
const submitting = ref(false);
const selectedModules = ref([]);
const selectedComponents = ref([]);
const selectedManuals = ref([]);
const selectedAnswers = ref([]);
const selectedNotes = ref([]);
const selectedCaptures = ref([]);
const selectedPatches = ref([]);
let pollTimer = null;

const answerHtml = computed(() => {
  if (!question.value?.answer) return '';
  return DOMPurify.sanitize(marked.parse(question.value.answer));
});

const isWorking = computed(() =>
  ['scoping', 'pending', 'answering'].includes(question.value?.status)
);
const isReview = computed(() => question.value?.status === 'scoped');

// Attachment choices narrow to whatever modules (and components) are
// currently selected.
const visibleComponents = computed(
  () => options.value?.components.filter((c) => selectedModules.value.includes(c.module_id)) ?? []
);
const chosenComponentIds = computed(() =>
  visibleComponents.value.filter((c) => selectedComponents.value.includes(c.id)).map((c) => c.id)
);
const visibleManuals = computed(
  () => options.value?.manuals.filter((m) => selectedModules.value.includes(m.module_id)) ?? []
);
const visibleAnswers = computed(
  () =>
    options.value?.answers.filter(
      (a) =>
        a.module_ids.some((id) => selectedModules.value.includes(id)) ||
        a.component_ids.some((id) => chosenComponentIds.value.includes(id))
    ) ?? []
);
const visibleNotes = computed(
  () =>
    options.value?.notes.filter(
      (n) =>
        n.module_ids.some((id) => selectedModules.value.includes(id)) ||
        n.component_ids.some((id) => chosenComponentIds.value.includes(id))
    ) ?? []
);
const chosenManualIds = computed(() =>
  visibleManuals.value.filter((m) => selectedManuals.value.includes(m.id)).map((m) => m.id)
);
const chosenAnswerIds = computed(() =>
  visibleAnswers.value.filter((a) => selectedAnswers.value.includes(a.id)).map((a) => a.id)
);
const chosenNoteIds = computed(() =>
  visibleNotes.value.filter((n) => selectedNotes.value.includes(n.id)).map((n) => n.id)
);
// Oscilloscope captures of the selected modules: the waveform image plus the
// tuner reading taken with it go to the model alongside the manuals.
const visibleCaptures = computed(
  () =>
    options.value?.captures?.filter(
      (c) =>
        c.module_ids.some((id) => selectedModules.value.includes(id)) ||
        c.component_ids.some((id) => chosenComponentIds.value.includes(id))
    ) ?? []
);
const chosenCaptureIds = computed(() =>
  visibleCaptures.value.filter((c) => selectedCaptures.value.includes(c.id)).map((c) => c.id)
);
// Patches are offered whatever the module selection: attaching one is what
// makes this a question about that patch, and it brings its own modules with
// it rather than being narrowed to the ones already picked.
const patchOptions = computed(() => options.value?.patches ?? []);
const chosenPatchIds = computed(() =>
  patchOptions.value.filter((p) => selectedPatches.value.includes(p.id)).map((p) => p.id)
);
const attachmentCount = computed(
  () =>
    chosenManualIds.value.length +
    chosenAnswerIds.value.length +
    chosenNoteIds.value.length +
    chosenCaptureIds.value.length +
    chosenPatchIds.value.length
);

// Adding a patch pulls the modules it uses into the scope, so the question is
// answered with their manuals rather than the patch text alone.
function onPatchToggled(patch) {
  if (!selectedPatches.value.includes(patch.id)) return;
  for (const id of patch.module_ids ?? []) {
    if (!selectedModules.value.includes(id)) selectedModules.value.push(id);
  }
}

function moduleLabel(moduleId) {
  const m = options.value?.modules.find((mod) => mod.id === moduleId);
  return m ? `${m.manufacturer} ${m.name}`.trim() : `module ${moduleId}`;
}

function manualLabel(m) {
  return m.name === 'manual' ? 'manual' : m.name;
}

async function loadOptions() {
  options.value = await api.get(`/api/questions/${props.id}/options`);
  selectedModules.value = options.value.modules.filter((m) => m.in_scope).map((m) => m.id);
  selectedComponents.value = options.value.components
    .filter((c) => c.in_scope)
    .map((c) => c.id);
  // Every module's primary manual starts selected (so adding a module later
  // brings its manual along); the user can untick any of them.
  selectedManuals.value = options.value.manuals
    .filter((m) => m.name === 'manual')
    .map((m) => m.id);
  selectedAnswers.value = [];
  selectedNotes.value = [];
  selectedCaptures.value = [];
  // A patch named when the question was asked stays attached through review.
  selectedPatches.value = (options.value.patches ?? [])
    .filter((p) => p.attached)
    .map((p) => p.id);
}

async function load() {
  try {
    question.value = await api.get(`/api/questions/${props.id}`);
    if (isReview.value && !options.value) await loadOptions();
    if (isWorking.value) {
      pollTimer = setTimeout(load, 3000);
    }
  } catch (e) {
    error.value = e.message;
  }
}

async function requestAnswer() {
  error.value = '';
  submitting.value = true;
  try {
    question.value = await api.post(`/api/questions/${props.id}/answer`, {
      module_ids: selectedModules.value,
      component_ids: chosenComponentIds.value,
      manual_ids: chosenManualIds.value,
      answer_ids: chosenAnswerIds.value,
      note_ids: chosenNoteIds.value,
      capture_ids: chosenCaptureIds.value,
      patch_ids: chosenPatchIds.value,
    });
    options.value = null;
    pollTimer = setTimeout(load, 3000);
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
  }
}

async function removeQuestion() {
  if (!confirm('Delete this question and its answer?')) return;
  error.value = '';
  try {
    await api.delete(`/api/questions/${props.id}`);
    clearTimeout(pollTimer);
    router.push('/questions');
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
onUnmounted(() => clearTimeout(pollTimer));
</script>

<template>
  <p><RouterLink to="/questions">← All questions</RouterLink></p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <template v-if="question">
    <h1 data-test="prompt">{{ question.prompt }}</h1>
    <p>
      <span class="badge" :class="question.status">{{ question.status }}</span>
      <button
        class="danger"
        style="margin: 0 0 0 0.8rem"
        data-test="delete-question"
        @click="removeQuestion"
      >
        Delete
      </button>
    </p>

    <div v-if="question.status === 'scoping'" class="panel" data-test="scoping">
      <p class="muted">
        Figuring out which of your modules this question applies to… this page refreshes
        automatically.
      </p>
    </div>

    <details v-else-if="isReview && options" open class="panel" data-test="review">
      <summary>
        <h2>Review scope &amp; attachments</h2>
      </summary>
      <div class="panel-body">
        <p class="muted">
          The assistant picked the modules it thinks are relevant. Adjust the selection, choose
          what to send along, then request the answer.
        </p>

        <!-- One list per kind of attachment, each folded away behind its
             heading with what it holds counted on the outside. -->
        <details open class="expander">
          <summary>
            <h3>Modules</h3>
            <span class="summary-count">
              {{ selectedModules.length }} of {{ options.modules.length }}
            </span>
          </summary>
          <div class="expander-body">
            <ul class="check-list">
              <li v-for="m in options.modules" :key="m.id">
                <label>
                  <input type="checkbox" :value="m.id" v-model="selectedModules" data-test="module-option" />
                  <span>
                    {{ m.manufacturer }} {{ m.name }}
                    <span v-if="m.in_scope" class="badge scoped">suggested</span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="visibleComponents.length > 0" class="expander">
          <summary>
            <h3>Components</h3>
            <span class="summary-count">
              {{ chosenComponentIds.length }} of {{ visibleComponents.length }}
            </span>
          </summary>
          <div class="expander-body">
            <ul class="check-list">
              <li v-for="c in visibleComponents" :key="c.id">
                <label>
                  <input
                    type="checkbox"
                    :value="c.id"
                    v-model="selectedComponents"
                    data-test="component-option"
                  />
                  <span>
                    {{ moduleLabel(c.module_id) }} — {{ c.name }}
                    <span class="badge">{{ c.type }}</span>
                    <span v-if="c.in_scope" class="badge scoped">suggested</span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details open class="expander">
          <summary>
            <h3>Manual documents</h3>
            <span class="summary-count">
              {{ chosenManualIds.length }} of {{ visibleManuals.length }}
            </span>
          </summary>
          <div class="expander-body">
            <p v-if="visibleManuals.length === 0" class="muted">
              No manual documents for the selected modules.
            </p>
            <ul v-else class="check-list">
              <li v-for="m in visibleManuals" :key="m.id">
                <label>
                  <input type="checkbox" :value="m.id" v-model="selectedManuals" data-test="manual-option" />
                  <span>
                    {{ moduleLabel(m.module_id) }} — {{ manualLabel(m) }}
                    <span v-if="m.source === 'upload'" class="badge">upload</span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="visibleAnswers.length > 0" class="expander">
          <summary>
            <h3>Previous answers</h3>
            <span class="summary-count">
              {{ chosenAnswerIds.length }} of {{ visibleAnswers.length }}
            </span>
          </summary>
          <div class="expander-body">
            <ul class="check-list">
              <li v-for="a in visibleAnswers" :key="a.id">
                <label>
                  <input type="checkbox" :value="a.id" v-model="selectedAnswers" data-test="answer-option" />
                  <span>{{ a.prompt }}</span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="visibleNotes.length > 0" class="expander">
          <summary>
            <h3>Notes</h3>
            <span class="summary-count">
              {{ chosenNoteIds.length }} of {{ visibleNotes.length }}
            </span>
          </summary>
          <div class="expander-body">
            <ul class="check-list">
              <li v-for="n in visibleNotes" :key="n.id">
                <label>
                  <input type="checkbox" :value="n.id" v-model="selectedNotes" data-test="note-option" />
                  <span>{{ n.title || n.body.slice(0, 80) }}</span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="visibleCaptures.length > 0" class="expander">
          <summary>
            <h3>Oscilloscope captures</h3>
            <span class="summary-count">
              {{ chosenCaptureIds.length }} of {{ visibleCaptures.length }}
            </span>
          </summary>
          <div class="expander-body">
            <ul class="check-list">
              <li v-for="c in visibleCaptures" :key="c.id">
                <label>
                  <input
                    type="checkbox"
                    :value="c.id"
                    v-model="selectedCaptures"
                    data-test="capture-option"
                  />
                  <span>
                    {{ c.title || `Capture #${c.id}` }}
                    <span class="muted">
                      — {{ c.channel_count }} channels, {{ new Date(c.captured_at).toLocaleString() }}
                    </span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="patchOptions.length > 0" class="expander">
          <summary>
            <h3>Patches</h3>
            <span class="summary-count">
              {{ chosenPatchIds.length }} of {{ patchOptions.length }}
            </span>
          </summary>
          <div class="expander-body">
            <p class="muted">
              Attach a patch and the question is answered from it: its cables, the control settings it
              records, the normalled connections it leaves intact and the signal flow they add up to.
              The modules the patch uses are added to the scope above.
            </p>
            <ul class="check-list">
              <li v-for="p in patchOptions" :key="p.id">
                <label>
                  <input
                    v-model="selectedPatches"
                    type="checkbox"
                    :value="p.id"
                    data-test="patch-option"
                    @change="onPatchToggled(p)"
                  />
                  <span>
                    {{ p.name }}
                    <span class="muted">
                      — {{ p.rack_name }}, {{ p.module_ids.length }} modules in play
                    </span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </details>

        <p v-if="selectedModules.length === 0" class="muted">Select at least one module.</p>
        <p v-else-if="attachmentCount === 0" class="muted">
          Attach at least one document (manual, previous answer, note, capture, or patch).
        </p>
        <button
          type="button"
          :disabled="submitting || selectedModules.length === 0 || attachmentCount === 0"
          data-test="request-answer"
          @click="requestAnswer"
        >
          Get answer
        </button>
      </div>
    </details>

    <template v-else>
      <details v-if="question.modules?.length" class="panel" data-test="modules">
        <summary>
          <h2>Modules in scope</h2>
        </summary>
        <div class="panel-body">
          <p>
            <template v-for="(m, i) in question.modules" :key="m.id">
              <RouterLink :to="`/modules/${m.id}`">{{ m.manufacturer }} {{ m.name }}</RouterLink>
              <span v-if="i < question.modules.length - 1">, </span>
            </template>
          </p>
        </div>
      </details>

      <details v-if="question.components?.length" class="panel" data-test="components">
        <summary>
          <h2>Jacks in scope</h2>
        </summary>
        <div class="panel-body">
          <ul>
            <li v-for="c in question.components" :key="c.id">
              {{ c.module_manufacturer }} {{ c.module_name }} — <strong>{{ c.name }}</strong>
              <span class="badge" :class="c.type === 'input_jack' ? 'pending' : 'found'">
                {{ c.type === 'input_jack' ? 'input' : c.type === 'bidirectional_jack' ? 'mult' : 'output' }}
              </span>
            </li>
          </ul>
        </div>
      </details>

      <details
        v-if="
          question.manuals?.length ||
          question.answers?.length ||
          question.notes?.length ||
          question.captures?.length ||
          question.patches?.length
        "
        class="panel"
        data-test="attachments"
      >
        <summary>
          <h2>Attached context</h2>
        </summary>
        <div class="panel-body">
          <ul>
            <li v-for="m in question.manuals" :key="`manual-${m.id}`">
              {{ m.module_manufacturer }} {{ m.module_name }} — {{ manualLabel(m) }}
              <span class="badge">document</span>
            </li>
            <li v-for="a in question.answers" :key="`answer-${a.id}`">
              <RouterLink :to="`/questions/${a.id}`">{{ a.prompt }}</RouterLink>
              <span class="badge">previous answer</span>
            </li>
            <li v-for="n in question.notes" :key="`note-${n.id}`">
              {{ n.title || `Note ${n.id}` }}
              <span class="badge">note</span>
            </li>
            <li v-for="c in question.captures" :key="`capture-${c.id}`">
              {{ c.title || `Capture ${c.id}` }}
              <span class="badge">waveform</span>
            </li>
            <li v-for="p in question.patches" :key="`patch-${p.id}`">
              <RouterLink :to="`/patches/${p.id}`">{{ p.name }}</RouterLink>
              <span class="badge">patch</span>
            </li>
          </ul>
        </div>
      </details>

      <div v-if="isWorking" class="panel" data-test="answer-pending">
        <p class="muted">
          The assistant is working on your answer… this page refreshes automatically.
        </p>
      </div>
      <div v-else-if="question.status === 'failed'" class="panel">
        <p class="error" data-test="answer-error">Failed: {{ question.error }}</p>
      </div>
      <details v-else-if="question.answer" open class="panel">
        <summary>
          <h2>Answer</h2>
        </summary>
        <div class="panel-body">
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
          <div class="answer" data-test="answer" v-html="answerHtml"></div>
        </div>
      </details>
    </template>
  </template>
</template>
