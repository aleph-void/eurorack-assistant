<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const config = ref(null);
const provider = ref('claude');
const model = ref('');
const importWorkers = ref(4);
const error = ref('');
const saved = ref(false);
const busy = ref(false);

const knownModels = computed(() => config.value?.known_models?.[provider.value] || []);
const defaultModel = computed(() => config.value?.default_models?.[provider.value] || '');

onMounted(async () => {
  try {
    config.value = await api.get('/api/config');
    provider.value = config.value.llm_provider;
    model.value = config.value.llm_model;
    importWorkers.value = Number(config.value.import_workers);
  } catch (e) {
    error.value = e.message;
  }
});

async function save() {
  error.value = '';
  saved.value = false;
  busy.value = true;
  try {
    config.value = { ...config.value, ...(await api.put('/api/config', {
      llm_provider: provider.value,
      llm_model: model.value,
      import_workers: importWorkers.value,
    })) };
    saved.value = true;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h1>Configuration</h1>
  <div class="panel">
    <p class="muted">
      Questions, manual research, and manual analysis are sent to this provider. The provider CLI
      (<code>claude</code> or <code>codex</code>) must be installed and logged in on the server.
    </p>
    <form @submit.prevent="save">
      <label for="provider">Provider</label>
      <select id="provider" v-model="provider" data-test="provider">
        <option v-for="p in config?.providers || ['claude', 'codex']" :key="p" :value="p">
          {{ p === 'claude' ? 'Claude Code CLI' : 'Codex CLI' }}
        </option>
      </select>

      <label for="model">Model (blank = provider default{{ defaultModel ? `: ${defaultModel}` : '' }})</label>
      <input id="model" v-model="model" data-test="model" list="known-models" />
      <datalist id="known-models">
        <option v-for="m in knownModels" :key="m" :value="m" />
      </datalist>

      <label for="import-workers">Import job workers (jobs processed in parallel)</label>
      <input
        id="import-workers"
        v-model.number="importWorkers"
        data-test="import-workers"
        type="number"
        min="1"
        step="1"
        required
      />

      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <p v-if="saved" class="success" data-test="saved">Configuration saved.</p>
      <button type="submit" :disabled="busy" data-test="save">Save</button>
    </form>
  </div>
</template>
