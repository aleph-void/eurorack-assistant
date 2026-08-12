<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const questions = ref([]);
const error = ref('');
const loading = ref(true);

onMounted(async () => {
  try {
    questions.value = await api.get('/api/questions');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '';
}

async function remove(q) {
  if (!confirm('Delete this question and its answer?')) return;
  error.value = '';
  try {
    await api.delete(`/api/questions/${q.id}`);
    questions.value = questions.value.filter((item) => item.id !== q.id);
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <h1>Your questions</h1>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else-if="questions.length === 0" class="panel">
    <p>No questions yet. <RouterLink to="/ask">Ask one</RouterLink>.</p>
  </div>
  <div v-else class="panel">
    <table data-test="question-table">
      <thead>
        <tr>
          <th>Question</th>
          <th>Status</th>
          <th>Asked</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="q in questions" :key="q.id">
          <td>
            <RouterLink :to="`/questions/${q.id}`">{{ q.prompt }}</RouterLink>
          </td>
          <td><span class="badge" :class="q.status">{{ q.status }}</span></td>
          <td class="muted">{{ formatDate(q.created_at) }}</td>
          <td>
            <button
              class="danger"
              style="margin: 0"
              :data-test="`delete-question-${q.id}`"
              @click="remove(q)"
            >
              Delete
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
