<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const racks = ref([]);
const error = ref('');
const loading = ref(true);
const newName = ref('');
const renamingId = ref(null);
const renameValue = ref('');

async function load() {
  try {
    racks.value = await api.get('/api/racks');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function create() {
  error.value = '';
  try {
    await api.post('/api/racks', { name: newName.value });
    newName.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function startRename(rack) {
  renamingId.value = rack.id;
  renameValue.value = rack.name;
}

async function rename(rack) {
  error.value = '';
  try {
    await api.put(`/api/racks/${rack.id}`, { name: renameValue.value });
    renamingId.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);

async function remove(rack) {
  if (!confirm(`Delete rack '${rack.name}' and remove its ${rack.module_count} module(s) from it?`))
    return;
  error.value = '';
  try {
    await api.delete(`/api/racks/${rack.id}`);
    racks.value = racks.value.filter((r) => r.id !== rack.id);
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <h1>Your racks</h1>
  <p class="muted">
    Racks group the modules in your systems. Deleting a rack only removes the modules from that
    rack — shared module records (manuals, analyses) are kept.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <table v-if="racks.length" data-test="rack-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Modules</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="rack in racks" :key="rack.id" :data-test="`rack-${rack.id}`">
          <td>
            <template v-if="renamingId === rack.id">
              <form style="display: inline" @submit.prevent="rename(rack)">
                <input
                  v-model="renameValue"
                  :data-test="`rename-input-${rack.id}`"
                  style="width: auto"
                />
                <button type="submit" style="margin: 0 0 0 0.4rem" :data-test="`rename-save-${rack.id}`">
                  Save
                </button>
                <button type="button" style="margin: 0 0 0 0.4rem" @click="renamingId = null">
                  Cancel
                </button>
              </form>
            </template>
            <template v-else>
              <RouterLink :to="{ path: '/modules', query: { rack: rack.id } }">
                {{ rack.name }}
              </RouterLink>
            </template>
          </td>
          <td>{{ rack.module_count }}</td>
          <td>
            <button
              v-if="renamingId !== rack.id"
              style="margin: 0 0.4rem 0 0"
              :data-test="`rename-${rack.id}`"
              @click="startRename(rack)"
            >
              Rename
            </button>
            <button class="danger" style="margin: 0" :data-test="`delete-${rack.id}`" @click="remove(rack)">
              Delete
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">
      No racks yet. <RouterLink to="/import">Import your module list</RouterLink> to create one.
    </p>

    <form @submit.prevent="create">
      <label for="new-rack">New rack</label>
      <div class="row">
        <input id="new-rack" v-model="newName" data-test="new-rack" placeholder="e.g. travel case" />
        <div class="shrink">
          <button type="submit" style="margin: 0" :disabled="!newName.trim()" data-test="create">
            Create
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
