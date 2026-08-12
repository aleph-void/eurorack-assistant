<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { useJobsStore } from '../stores/jobs.js';

const route = useRoute();
const modules = ref([]);
const racks = ref([]);
// '' shows every rack (deduped); a rack id narrows the list to that rack.
const selectedRack = ref(route.query.rack ? Number(route.query.rack) : '');
const error = ref('');
const loading = ref(true);
const jobs = useJobsStore();

const currentRack = computed(() => racks.value.find((r) => r.id === selectedRack.value) || null);
const otherRacks = computed(() => racks.value.filter((r) => r.id !== selectedRack.value));

async function load() {
  try {
    racks.value = await api.get('/api/racks');
    const query = selectedRack.value ? `?rack_id=${selectedRack.value}` : '';
    modules.value = await api.get(`/api/modules${query}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function rackNames(module) {
  return (module.racks || []).map((r) => r.name).join(', ');
}

async function remove(module) {
  const where = currentRack.value ? `from rack '${currentRack.value.name}'` : 'from all your racks';
  if (
    !confirm(
      `Delete ${module.manufacturer} ${module.name} ${where}? ` +
        'If it ends up in no rack at all, the module and its manuals, notes and ' +
        'questions are permanently deleted.'
    )
  )
    return;
  try {
    const query = selectedRack.value ? `?rack_id=${selectedRack.value}` : '';
    await api.delete(`/api/modules/${module.id}${query}`);
    modules.value = modules.value.filter((m) => m.id !== module.id);
  } catch (e) {
    error.value = e.message;
  }
}

// Move a module from the selected rack into another one (quantities merge if
// the target rack already has it).
async function move(module, event) {
  const toRackId = Number(event.target.value);
  event.target.value = '';
  if (!toRackId) return;
  error.value = '';
  try {
    await api.post(`/api/racks/${selectedRack.value}/modules/${module.id}/move`, {
      to_rack_id: toRackId,
    });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

watch(selectedRack, load);

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
  <div class="row">
    <div>
      <label for="rack-select">Rack</label>
      <select id="rack-select" v-model="selectedRack" data-test="rack-select">
        <option value="">All racks</option>
        <option v-for="rack in racks" :key="rack.id" :value="rack.id">{{ rack.name }}</option>
      </select>
    </div>
    <div class="shrink" style="align-self: end">
      <RouterLink to="/racks">Manage racks</RouterLink>
    </div>
  </div>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else-if="modules.length === 0" class="panel">
    <p>
      No modules {{ currentRack ? `in '${currentRack.name}'` : 'yet' }}.
      <RouterLink to="/import">Import your module list</RouterLink> to get started.
    </p>
  </div>
  <div v-else class="panel">
    <table data-test="module-table">
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Module</th>
          <th>Qty</th>
          <th v-if="!currentRack">Rack(s)</th>
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
          <td v-if="!currentRack">{{ rackNames(module) }}</td>
          <td><span class="badge" :class="module.manual_status">{{ module.manual_status }}</span></td>
          <td>
            <span class="badge" :class="module.analysis_status">{{ module.analysis_status }}</span>
          </td>
          <td>
            <select
              v-if="currentRack && otherRacks.length > 0"
              style="width: auto; margin: 0 0.4rem 0 0"
              :data-test="`move-${module.id}`"
              @change="move(module, $event)"
            >
              <option value="">Move to…</option>
              <option v-for="rack in otherRacks" :key="rack.id" :value="rack.id">
                {{ rack.name }}
              </option>
            </select>
            <button class="danger" style="margin: 0" @click="remove(module)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
