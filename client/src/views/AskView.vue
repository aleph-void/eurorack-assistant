<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';

const router = useRouter();
const prompt = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const question = await api.post('/api/questions', { prompt: prompt.value });
    router.push({ name: 'question-detail', params: { id: question.id } });
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h1>Ask about your system</h1>
  <div class="panel">
    <form @submit.prevent="submit">
      <label for="prompt">Question</label>
      <textarea
        id="prompt"
        v-model="prompt"
        data-test="prompt"
        placeholder="e.g. How do I patch a krell using Maths and my filters?"
      ></textarea>
      <p class="muted">
        The assistant figures out which of your modules are relevant, reads their manuals, and
        answers with your previous related questions as extra context.
      </p>
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <button type="submit" :disabled="busy || !prompt.trim()" data-test="submit">Ask</button>
    </form>
  </div>
</template>
