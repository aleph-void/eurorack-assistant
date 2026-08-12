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
</template>
