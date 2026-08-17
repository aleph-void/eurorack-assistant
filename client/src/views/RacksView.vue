<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ShareButton from '../components/ShareButton.vue';

const racks = ref([]);
const error = ref('');
const notice = ref('');
const loading = ref(true);
const newName = ref('');
const renamingId = ref(null);
const renameValue = ref('');
const organizer = ref(null);
const organizingRackId = ref(null);
const layoutBusy = ref(false);
const dragged = ref(null);

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

// The zip is built by a background job; when its 'completed' event arrives
// over the WebSocket the jobs store starts the download automatically.
async function exportRack(rack) {
  error.value = '';
  notice.value = '';
  try {
    await api.post(`/api/racks/${rack.id}/export`);
    notice.value =
      `Export of '${rack.name}' queued — the zip downloads automatically when it is ready ` +
      '(progress is on the Jobs page).';
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(rack) {
  const ok = await dialog.confirm({
    title: 'Delete rack',
    message:
      `Delete rack '${rack.name}' and its ${rack.module_count} module(s)? ` +
      'Modules not in any other rack are permanently deleted, along with their ' +
      'manuals, notes and questions.',
    confirmLabel: 'Delete rack',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/racks/${rack.id}`);
    racks.value = racks.value.filter((r) => r.id !== rack.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function openOrganizer(rack) {
  if (organizingRackId.value === rack.id) {
    organizingRackId.value = null;
    organizer.value = null;
    return;
  }
  error.value = '';
  try {
    organizer.value = await api.get(`/api/racks/${rack.id}`);
    organizingRackId.value = rack.id;
  } catch (e) {
    error.value = e.message;
  }
}

const placedCounts = computed(() => {
  const counts = new Map();
  for (const row of organizer.value?.rows || []) {
    for (const module of row.modules || []) counts.set(module.module_id, (counts.get(module.module_id) || 0) + 1);
  }
  return counts;
});
const availableModules = computed(() =>
  (organizer.value?.modules || []).flatMap((module) =>
    Array.from({ length: Math.max(0, module.quantity - (placedCounts.value.get(module.id) || 0)) }, () => module)
  )
);
const rowUsed = (row) => (row.modules || []).reduce((sum, module) => sum + (Number(module.hp) || 0), 0);

async function saveLayout() {
  if (!organizer.value) return;
  layoutBusy.value = true;
  error.value = '';
  try {
    const result = await api.put(`/api/racks/${organizer.value.id}/layout`, {
      rows: organizer.value.rows.map((row) => ({
        unit: Number(row.unit),
        hp: Number(row.hp),
        modules: row.modules.map((module) => ({ module_id: module.module_id })),
      })),
    });
    organizer.value = { ...organizer.value, rows: result.rows };
  } catch (e) {
    error.value = e.message;
    // Return to the stored layout after a capacity or validation failure.
    organizer.value = await api.get(`/api/racks/${organizer.value.id}`);
  } finally {
    layoutBusy.value = false;
  }
}

async function addRow(unit) {
  organizer.value.rows.push({ unit, hp: unit === 1 ? 104 : 104, modules: [] });
  await saveLayout();
}

async function removeRow(index) {
  organizer.value.rows.splice(index, 1);
  await saveLayout();
}

function startDrag(module, rowIndex = null) {
  dragged.value = { module, rowIndex };
}

async function dropIntoRow(rowIndex) {
  const held = dragged.value;
  dragged.value = null;
  if (!held || !organizer.value) return;
  const row = organizer.value.rows[rowIndex];
  if (held.rowIndex !== null) organizer.value.rows[held.rowIndex].modules.splice(
    organizer.value.rows[held.rowIndex].modules.findIndex((module) => module.module_id === held.module.module_id),
    1
  );
  if (rowUsed(row) + (Number(held.module.hp) || 0) > Number(row.hp)) {
    if (held.rowIndex !== null) organizer.value.rows[held.rowIndex].modules.push(held.module);
    error.value = `${held.module.manufacturer} ${held.module.name} does not fit in this ${row.hp}HP row.`;
    return;
  }
  row.modules.push(held.module);
  await saveLayout();
}

async function dropIntoAvailable() {
  const held = dragged.value;
  dragged.value = null;
  if (!held || held.rowIndex === null || !organizer.value) return;
  const row = organizer.value.rows[held.rowIndex];
  row.modules.splice(row.modules.findIndex((module) => module.module_id === held.module.module_id), 1);
  await saveLayout();
}
</script>

<template>
  <h1>Your racks</h1>
  <p class="muted">
    Racks group the modules in your systems. Deleting a rack deletes the modules in it — a module
    survives only if it is still in another rack.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="notice" class="success" data-test="notice">{{ notice }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="racks.length" class="table-wrap">
      <table data-test="rack-table">
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
              <ShareButton type="rack" :id="rack.id" :label="rack.name" small />
              <button
                v-if="renamingId !== rack.id"
                style="margin: 0 0.4rem"
                :data-test="`rename-${rack.id}`"
                @click="startRename(rack)"
              >
                Rename
              </button>
              <button
                class="secondary"
                style="margin: 0 0.4rem 0 0"
                :disabled="rack.module_count === 0"
                :data-test="`export-${rack.id}`"
                @click="exportRack(rack)"
              >
                Export Rack
              </button>
              <button
                class="secondary"
                style="margin: 0 0.4rem 0 0"
                :data-test="`organize-${rack.id}`"
                @click="openOrganizer(rack)"
              >
                {{ organizingRackId === rack.id ? 'Close organizer' : 'Organize' }}
              </button>
              <button class="danger" style="margin: 0" :data-test="`delete-${rack.id}`" @click="remove(rack)">
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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

    <section v-if="organizer" class="rack-organizer" data-test="rack-organizer">
      <h2>Organize {{ organizer.name }}</h2>
      <p class="muted">
        Add 3U and 1U rows, set their HP, then drag each module copy into its physical row. A row
        cannot exceed its HP capacity.
      </p>
      <div class="row">
        <button class="secondary" :disabled="layoutBusy" data-test="add-3u-row" @click="addRow(3)">Add 3U row</button>
        <button class="secondary" :disabled="layoutBusy" data-test="add-1u-row" @click="addRow(1)">Add 1U row</button>
      </div>

      <div class="available-modules" data-test="available-modules" @dragover.prevent @drop="dropIntoAvailable">
        <h3>Available modules</h3>
        <p v-if="availableModules.length === 0" class="muted">Every module copy is placed.</p>
        <div v-else class="module-chips">
          <button
            v-for="(module, index) in availableModules"
            :key="`${module.id}-${index}`"
            class="module-chip"
            draggable="true"
            type="button"
            :data-test="`available-module-${module.id}-${index}`"
            @dragstart="startDrag(module)"
          >
            {{ module.manufacturer }} {{ module.name }} <span>{{ module.hp ? `${module.hp}HP` : 'HP unknown' }}</span>
          </button>
        </div>
      </div>

      <div v-for="(row, rowIndex) in organizer.rows" :key="row.id ?? rowIndex" class="rack-row" :data-test="`rack-row-${rowIndex}`">
        <div class="rack-row-meta">
          <label>Unit
            <select v-model.number="row.unit" :disabled="layoutBusy" @change="saveLayout">
              <option :value="3">3U</option>
              <option :value="1">1U</option>
            </select>
          </label>
          <label>HP
            <input v-model.number="row.hp" type="number" min="1" max="504" :disabled="layoutBusy" @change="saveLayout" />
          </label>
          <span class="muted">{{ rowUsed(row) }} / {{ row.hp }}HP</span>
          <button class="danger" style="margin: 0 0 0 auto" :disabled="layoutBusy" @click="removeRow(rowIndex)">Remove row</button>
        </div>
        <div class="rack-row-slots" @dragover.prevent @drop="dropIntoRow(rowIndex)">
          <button
            v-for="(module, index) in row.modules"
            :key="`${module.module_id}-${index}`"
            class="placed-module"
            draggable="true"
            type="button"
            @dragstart="startDrag(module, rowIndex)"
          >
            {{ module.manufacturer }} {{ module.name }} · {{ module.hp }}HP
          </button>
          <span v-if="row.modules.length === 0" class="muted">Drop modules here</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rack-organizer { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem; }
.available-modules, .rack-row-slots { min-height: 3.5rem; border: 1px dashed var(--border-strong); border-radius: 7px; padding: 0.6rem; }
.available-modules { margin: 1rem 0; }
.module-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.module-chip, .placed-module { margin: 0; cursor: grab; text-align: left; }
.module-chip span { color: var(--muted); }
.rack-row { margin: 0.8rem 0; }
.rack-row-meta { display: flex; align-items: end; gap: 0.7rem; margin-bottom: 0.35rem; }
.rack-row-meta label { display: grid; gap: 0.15rem; font-size: 0.85rem; }
.rack-row-meta input, .rack-row-meta select { width: 6rem; margin: 0; }
.rack-row-slots { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
</style>
