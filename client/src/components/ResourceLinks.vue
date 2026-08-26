<script setup>
// The links kept beside one record — a module, a patch, a rack or a system.
//
// A module's story is not all in its manual: it is the forum thread about the
// firmware, the maker's page, the video of the patch you are rebuilding. A
// rack has the case's build thread, a system the plan you drew before you
// bought any of it. None of that is a document to store, so none of it had
// anywhere to go.
//
// Four owners, one panel: only the query key and the word for the thing
// differ, so this is one component the four pages pass their kind to.
//
// Every link opens in a new tab with `rel="noopener noreferrer"` — a page you
// hand the tab to can otherwise steer the one it came from — and the server
// stores nothing but http and https, so a `javascript:` URL never reaches a
// renderer here.
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  // 'module' | 'patch' | 'rack' | 'system'
  kind: { type: String, required: true },
  recordId: { type: [String, Number], required: true },
  // Panels inside a page that is already a list (the rack organizer, the
  // system floor plan) start closed.
  open: { type: Boolean, default: true },
});

const links = ref([]);
const loading = ref(true);
const listError = ref('');
const busy = ref(false);
const formError = ref('');

const newUrl = ref('');
const newTitle = ref('');
const newDescription = ref('');

const editing = ref(null);
const editUrl = ref('');
const editTitle = ref('');
const editDescription = ref('');

const ownerKey = computed(() => `${props.kind}_id`);
const query = computed(() => `${ownerKey.value}=${props.recordId}`);

async function load() {
  loading.value = true;
  listError.value = '';
  try {
    links.value = await api.get(`/api/links?${query.value}`);
  } catch (e) {
    listError.value = e.message;
    links.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(
  () => [props.kind, props.recordId],
  () => {
    editing.value = null;
    load();
  }
);

async function add() {
  formError.value = '';
  busy.value = true;
  try {
    const created = await api.post('/api/links', {
      [ownerKey.value]: Number(props.recordId),
      url: newUrl.value,
      title: newTitle.value,
      description: newDescription.value,
    });
    links.value = [...links.value, created];
    newUrl.value = '';
    newTitle.value = '';
    newDescription.value = '';
  } catch (e) {
    formError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function startEdit(link) {
  editing.value = link.id;
  editUrl.value = link.url;
  editTitle.value = link.title ?? '';
  editDescription.value = link.description ?? '';
  formError.value = '';
}

async function saveEdit(link) {
  formError.value = '';
  try {
    const updated = await api.put(`/api/links/${link.id}`, {
      url: editUrl.value,
      title: editTitle.value,
      description: editDescription.value,
    });
    links.value = links.value.map((l) => (l.id === updated.id ? updated : l));
    editing.value = null;
  } catch (e) {
    formError.value = e.message;
  }
}

async function remove(link) {
  try {
    await api.delete(`/api/links/${link.id}`);
    links.value = links.value.filter((l) => l.id !== link.id);
  } catch {
    /* api.js has already said so */
  }
}

// Moving a link is the two rows swapping positions, both written: the order
// is the user's, so a link never moves because another one did.
async function move(link, delta) {
  const index = links.value.findIndex((l) => l.id === link.id);
  const other = links.value[index + delta];
  if (!other) return;
  const ordered = [...links.value];
  ordered[index] = other;
  ordered[index + delta] = link;
  links.value = ordered;
  try {
    await Promise.all(
      ordered.map((l, position) => api.put(`/api/links/${l.id}`, { position }))
    );
  } catch {
    // The server is the truth about an order that failed to save.
    await load();
  }
}
</script>

<template>
  <details :open="open" class="panel" data-test="resource-links">
    <summary>
      <h2>Links</h2>
      <span class="summary-count">
        {{ links.length }} {{ links.length === 1 ? 'link' : 'links' }}
      </span>
    </summary>
    <div class="panel-body">
      <form class="link-form" data-test="link-form" @submit.prevent="add">
        <label :for="`link-url-${kind}-${recordId}`">Address</label>
        <input
          :id="`link-url-${kind}-${recordId}`"
          v-model="newUrl"
          type="text"
          placeholder="modwiggler.com/forum/viewtopic.php?t=…"
          data-test="link-url"
        />
        <label :for="`link-title-${kind}-${recordId}`">Title</label>
        <input
          :id="`link-title-${kind}-${recordId}`"
          v-model="newTitle"
          type="text"
          placeholder="Optional — the site's name is used otherwise"
          data-test="link-title"
        />
        <label :for="`link-note-${kind}-${recordId}`">Note</label>
        <textarea
          :id="`link-note-${kind}-${recordId}`"
          v-model="newDescription"
          rows="2"
          placeholder="Optional — what is worth remembering about it"
          data-test="link-description"
        ></textarea>
        <p v-if="formError" class="error" data-test="link-error">{{ formError }}</p>
        <button type="submit" :disabled="busy || !newUrl.trim()" data-test="link-add">
          Add link
        </button>
      </form>

      <p v-if="listError" class="error" data-test="links-list-error">{{ listError }}</p>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="links.length === 0" class="muted" data-test="no-links">
        No links on this {{ kind }} yet.
      </p>
      <div v-else class="table-wrap">
        <table data-test="links-table">
          <thead>
            <tr>
              <th>Link</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(link, index) in links" :key="link.id" :data-test="`link-${link.id}`">
              <td data-label="Link">
                <template v-if="editing === link.id">
                  <input v-model="editUrl" type="text" data-test="link-edit-url" />
                  <input v-model="editTitle" type="text" data-test="link-edit-title" />
                </template>
                <template v-else>
                  <a :href="link.url" target="_blank" rel="noopener noreferrer">
                    {{ link.title || link.url }}
                  </a>
                  <span class="url muted">{{ link.url }}</span>
                </template>
              </td>
              <td data-label="Note">
                <textarea
                  v-if="editing === link.id"
                  v-model="editDescription"
                  rows="2"
                  data-test="link-edit-description"
                ></textarea>
                <span v-else class="muted">{{ link.description }}</span>
              </td>
              <td>
                <div class="actions">
                  <template v-if="editing === link.id">
                    <button type="button" data-test="link-save" @click="saveEdit(link)">Save</button>
                    <button type="button" class="secondary" @click="editing = null">Cancel</button>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="secondary"
                      :disabled="index === 0"
                      title="Move up"
                      data-test="link-up"
                      @click="move(link, -1)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="secondary"
                      :disabled="index === links.length - 1"
                      title="Move down"
                      data-test="link-down"
                      @click="move(link, 1)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="secondary"
                      data-test="link-edit"
                      @click="startEdit(link)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="danger"
                      data-test="link-delete"
                      @click="remove(link)"
                    >
                      Delete
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </details>
</template>

<style scoped>
.link-form {
  margin-bottom: 1rem;
}

/* The address under the title: a link named "Firmware thread" still has to
   say where it goes before anyone clicks it. */
.url {
  display: block;
  font-size: 0.8rem;
  word-break: break-all;
}
</style>
