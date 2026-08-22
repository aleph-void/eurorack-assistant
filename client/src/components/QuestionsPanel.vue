<script setup>
// The questions asked about ONE record — a module or a patch — and the box
// that asks the next one. Asking from here is not the same as typing the
// module's name on the Ask page: the record goes into the question's scope as
// it is created (`module_ids`/`patch_ids` on POST /api/questions), so the
// answer is about this module even when the wording never names it ("why is
// this so quiet?"), and a patch brings its cables and settings with it.
//
// Both pages are the same list of the same records, so they are one panel:
// only the word for the thing and the query key differ.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';

const props = defineProps({
  // 'module' or 'patch' — the query key, the payload key and the wording.
  kind: { type: String, required: true },
  recordId: { type: String, required: true },
});

const router = useRouter();
const questions = ref([]);
const loading = ref(true);
const listError = ref('');
const prompt = ref('');
const askError = ref('');
const busy = ref(false);

const noun = computed(() => (props.kind === 'patch' ? 'patch' : 'module'));

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
watch(() => props.recordId, load);

async function ask() {
  askError.value = '';
  busy.value = true;
  try {
    const question = await api.post('/api/questions', {
      prompt: prompt.value,
      [`${noun.value}_ids`]: [Number(props.recordId)],
    });
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
        <p class="muted">
          This {{ noun }} is in the question's scope from the start<span v-if="noun === 'patch'">,
          with its cables, control settings and signal flow attached</span>. You still review the
          scope — adding modules, documents, notes and previous answers — before the answer is
          generated.
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
              <td>
                <RouterLink :to="`/questions/${q.id}`">{{ q.prompt }}</RouterLink>
              </td>
              <td><span class="badge" :class="q.status">{{ q.status }}</span></td>
              <td class="muted">{{ formatDate(q.created_at) }}</td>
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
