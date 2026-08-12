<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { useJobsStore } from '../stores/jobs.js';

const modules = ref([]);
const error = ref('');
const loading = ref(true);
const jobs = useJobsStore();

async function load() {
  try {
    modules.value = await api.get('/api/modules');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function remove(module) {
  if (!confirm(`Delete ${module.manufacturer} ${module.name}?`)) return;
  try {
    await api.delete(`/api/modules/${module.id}`);
    modules.value = modules.value.filter((m) => m.id !== module.id);
  } catch (e) {
    error.value = e.message;
  }
}

// Live-refresh when background jobs finish (manual found, analysis complete).
let refreshTimer = null;
watch(
  () => jobs.feed.length,
  () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      load();
    }, 500);
  }
);

onMounted(load);
onUnmounted(() => clearTimeout(refreshTimer));
</script>

<template>
  <h1>Your modules</h1>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else-if="modules.length === 0" class="panel">
    <p>No modules yet. <RouterLink to="/import">Import your module list</RouterLink> to get started.</p>
  </div>
  <div v-else class="panel">
    <table data-test="module-table">
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Module</th>
          <th>Qty</th>
          <th>Manual</th>
          <th>Analysis</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="module in modules" :key="module.id" :data-test="`module-${module.id}`">
          <td>{{ module.manufacturer }}</td>
          <td>
            <RouterLink :to="`/modules/${module.id}`">{{ module.name }}</RouterLink>
          </td>
          <td>{{ module.quantity }}</td>
          <td><span class="badge" :class="module.manual_status">{{ module.manual_status }}</span></td>
          <td>
            <span class="badge" :class="module.analysis_status">{{ module.analysis_status }}</span>
          </td>
          <td>
            <button class="danger" style="margin: 0" @click="remove(module)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
