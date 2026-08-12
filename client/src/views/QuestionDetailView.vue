<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });

const question = ref(null);
const error = ref('');
let pollTimer = null;

const answerHtml = computed(() => {
  if (!question.value?.answer) return '';
  return DOMPurify.sanitize(marked.parse(question.value.answer));
});

const isPending = computed(() =>
  ['pending', 'answering'].includes(question.value?.status)
);

async function load() {
  try {
    question.value = await api.get(`/api/questions/${props.id}`);
    if (isPending.value) {
      pollTimer = setTimeout(load, 3000);
    }
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
onUnmounted(() => clearTimeout(pollTimer));
</script>

<template>
  <p><RouterLink to="/questions">← All questions</RouterLink></p>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="question">
    <h1 data-test="prompt">{{ question.prompt }}</h1>
    <p>
      <span class="badge" :class="question.status">{{ question.status }}</span>
    </p>

    <div v-if="question.modules?.length" class="panel" data-test="modules">
      <h2>Modules in scope</h2>
      <p>
        <template v-for="(m, i) in question.modules" :key="m.id">
          <RouterLink :to="`/modules/${m.id}`">{{ m.manufacturer }} {{ m.name }}</RouterLink>
          <span v-if="i < question.modules.length - 1">, </span>
        </template>
      </p>
    </div>

    <div v-if="question.components?.length" class="panel" data-test="components">
      <h2>Jacks in scope</h2>
      <ul>
        <li v-for="c in question.components" :key="c.id">
          {{ c.module_manufacturer }} {{ c.module_name }} — <strong>{{ c.name }}</strong>
          <span class="badge" :class="c.type === 'input_jack' ? 'pending' : 'found'">
            {{ c.type === 'input_jack' ? 'input' : 'output' }}
          </span>
        </li>
      </ul>
    </div>

    <div v-if="isPending" class="panel" data-test="answer-pending">
      <p class="muted">The assistant is working on your answer… this page refreshes automatically.</p>
    </div>
    <div v-else-if="question.status === 'failed'" class="panel">
      <p class="error" data-test="answer-error">Failed: {{ question.error }}</p>
    </div>
    <div v-else-if="question.answer" class="panel">
      <h2>Answer</h2>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
      <div class="answer" data-test="answer" v-html="answerHtml"></div>
    </div>
  </template>
</template>
