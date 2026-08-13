<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ShareButton from '../components/ShareButton.vue';

const patches = ref([]);
const racks = ref([]);
const error = ref('');
const loading = ref(true);
const newName = ref('');
const newRackId = ref('');
const newDescription = ref('');

async function load() {
  try {
    [patches.value, racks.value] = await Promise.all([
      api.get('/api/patches'),
      api.get('/api/racks'),
    ]);
    // Preselect the only (or first) rack with modules in it.
    if (!newRackId.value) {
      const usable = racks.value.find((r) => r.module_count > 0);
      if (usable) newRackId.value = usable.id;
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function create() {
  error.value = '';
  try {
    await api.post('/api/patches', {
      rack_id: Number(newRackId.value),
      name: newName.value,
      description: newDescription.value.trim() || undefined,
    });
    newName.value = '';
    newDescription.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// ---- reading a patch back in from a file ----
// A patch exported here or on somebody else's install. Modules are matched by
// name against what you have; whatever does not match comes in by name, which
// the import reports rather than silently dropping.
const importRackId = ref('');
const importing = ref(false);
const importNotice = ref('');

async function importPatch(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  error.value = '';
  importNotice.value = '';
  importing.value = true;
  try {
    let document;
    try {
      document = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} is not a JSON file the app can read.`);
    }
    const created = await api.post('/api/patches/import', {
      document,
      rack_id: importRackId.value || undefined,
    });
    const missing = created.unresolved_modules ?? [];
    importNotice.value =
      `Imported '${created.name}' — ${created.module_count} module(s), ` +
      `${created.cable_count} cable(s).` +
      (missing.length
        ? ` ${missing.length} module(s) are not in your racks and came in by name only: ` +
          `${missing.join(', ')}.`
        : '');
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    importing.value = false;
  }
}

// A patch is often the starting point for the next one: the same voice with
// one thing moved. Copying keeps the original intact.
async function duplicate(patch) {
  error.value = '';
  try {
    await api.post(`/api/patches/${patch.id}/clone`, {});
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(patch) {
  const ok = await dialog.confirm({
    title: 'Delete patch',
    message: `Delete patch '${patch.name}'? Its cables and settings are lost.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/patches/${patch.id}`);
    patches.value = patches.value.filter((p) => p.id !== patch.id);
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <h1>Your patches</h1>
  <p class="muted">
    A patch records the cables and control settings of one moment in a rack. It keeps a snapshot
    of the rack's modules from when it was created, so it stays intact when modules later move or
    disappear.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="patches.length" class="table-wrap">
      <table data-test="patch-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Rack</th>
            <th>Modules</th>
            <th>Cables</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="patch in patches" :key="patch.id" :data-test="`patch-${patch.id}`">
            <td>
              <RouterLink :to="`/patches/${patch.id}`">{{ patch.name }}</RouterLink>
              <span v-if="patch.description" class="muted"> — {{ patch.description }}</span>
            </td>
            <td>{{ patch.rack_name }}</td>
            <td>{{ patch.module_count }}</td>
            <td>{{ patch.cable_count }}</td>
            <td>{{ new Date(patch.created_at).toLocaleString() }}</td>
            <td>
              <a
                class="export-link"
                :href="`/api/patches/${patch.id}/export`"
                :data-test="`export-${patch.id}`"
                title="Download this patch as a JSON file"
              >
                Export
              </a>
              <ShareButton type="patch" :id="patch.id" :label="patch.name" small />
              <button
                class="secondary"
                style="margin: 0 0 0 0.4rem"
                :data-test="`duplicate-${patch.id}`"
                @click="duplicate(patch)"
              >
                Duplicate
              </button>
              <button
                class="danger"
                style="margin: 0 0 0 0.4rem"
                :data-test="`delete-${patch.id}`"
                @click="remove(patch)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted" data-test="empty">No patches yet — create one from a rack below.</p>

    <form @submit.prevent="create">
      <label for="new-patch-name">New patch</label>
      <div class="row">
        <input
          id="new-patch-name"
          v-model="newName"
          data-test="new-name"
          placeholder="e.g. Krell patch"
        />
        <div>
          <select id="new-patch-rack" v-model="newRackId" data-test="new-rack" aria-label="Rack">
            <option value="" disabled>Select a rack…</option>
            <option v-for="rack in racks" :key="rack.id" :value="rack.id">
              {{ rack.name }} ({{ rack.module_count }} modules)
            </option>
          </select>
        </div>
        <input
          v-model="newDescription"
          data-test="new-description"
          placeholder="Description (optional)"
          style="flex: 2"
        />
        <div class="shrink">
          <button
            type="submit"
            style="margin: 0"
            :disabled="!newName.trim() || !newRackId"
            data-test="create"
          >
            Create
          </button>
        </div>
      </div>
    </form>

    <label for="import-patch">Or import a patch file</label>
    <p class="muted" style="margin-top: 0">
      A <code>.patch.json</code> file exported from here or from somebody else's install. Modules
      are matched to yours by name; anything you do not have comes in by name, so the patch still
      reads.
    </p>
    <p v-if="importNotice" class="success" data-test="import-notice">{{ importNotice }}</p>
    <div class="row">
      <div>
        <select v-model="importRackId" data-test="import-rack" aria-label="File it under a rack">
          <option value="">No rack of mine</option>
          <option v-for="rack in racks" :key="rack.id" :value="rack.id">{{ rack.name }}</option>
        </select>
      </div>
      <input
        id="import-patch"
        type="file"
        accept="application/json,.json"
        data-test="import-patch"
        :disabled="importing"
        @change="importPatch"
      />
    </div>
  </div>
</template>

<style scoped>
.export-link {
  font-size: 0.85rem;
  margin-right: 0.4rem;
}
</style>
