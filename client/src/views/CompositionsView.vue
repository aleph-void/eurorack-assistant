<script setup>
// The user's compositions: the pieces of music, as distinct from the patches
// that play them. A composition is storyboarded (scenes across, parts down)
// and then mapped onto one or more patches.
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { dialog } from '../dialog.js';

const router = useRouter();
const compositions = ref([]);
const PAGE = 100;
const total = ref(0);
const hasMore = ref(false);
const nextBefore = ref(null);
const loadingMore = ref(false);
const loading = ref(true);
const error = ref('');
const newName = ref('');
const newDescription = ref('');
const newTempo = ref('');

function applyPage(page, { append = false } = {}) {
  const rows = page?.compositions ?? [];
  compositions.value = append ? compositions.value.concat(rows) : rows;
  total.value = page?.total ?? compositions.value.length;
  hasMore.value = Boolean(page?.has_more);
  nextBefore.value = page?.next_before ?? null;
}

async function load() {
  try {
    applyPage(await api.get(`/api/compositions?limit=${PAGE}`));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    applyPage(await api.get(`/api/compositions?limit=${PAGE}&before=${nextBefore.value}`), {
      append: true,
    });
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMore.value = false;
  }
}

// A new composition opens on its storyboard: the next thing to do is write
// it.
async function create() {
  error.value = '';
  try {
    const created = await api.post('/api/compositions', {
      name: newName.value,
      description: newDescription.value.trim() || undefined,
      tempo_bpm: newTempo.value === '' ? undefined : newTempo.value,
    });
    router.push(`/compositions/${created.id}`);
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(composition) {
  const ok = await dialog.confirm({
    title: 'Delete composition',
    message: `Delete '${composition.name}'? Its storyboard and every mapping onto a patch are lost; the patches themselves stay.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/compositions/${composition.id}`);
    compositions.value = compositions.value.filter((c) => c.id !== composition.id);
    total.value = Math.max(0, total.value - 1);
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <h1>Your compositions</h1>
  <p class="muted">
    A composition is the piece, as distinct from any patch that plays it: its scenes in order, the
    parts it is made of, and what each part does in each scene. Written before the patch exists,
    it survives the case being rebuilt — map it onto whichever patch performs it, and each part is
    bound to the module, control, bus or cable that plays it there.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="compositions.length" class="table-wrap">
      <table data-test="composition-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scenes</th>
            <th>Parts</th>
            <th>Patches</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in compositions" :key="c.id" :data-test="`composition-${c.id}`">
            <td data-label="Name">
              <RouterLink :to="`/compositions/${c.id}`">{{ c.name }}</RouterLink>
              <span v-if="c.tempo_bpm" class="badge">{{ c.tempo_bpm }} BPM</span>
              <span v-if="c.description" class="muted"> — {{ c.description }}</span>
            </td>
            <td data-label="Scenes">{{ c.scene_count }}</td>
            <td data-label="Parts">{{ c.element_count }}</td>
            <td data-label="Patches">{{ c.patch_count }}</td>
            <td>
              <div class="actions">
                <button type="button" class="danger" :data-test="`delete-${c.id}`" @click="remove(c)">
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted" data-test="no-compositions">No compositions yet.</p>
    <p v-if="compositions.length" class="muted" data-test="composition-count">
      Showing {{ compositions.length }} of {{ total }}
      <button v-if="hasMore" type="button" class="secondary" :disabled="loadingMore" data-test="load-more" @click="loadMore">
        Show more
      </button>
    </p>
  </div>

  <div class="panel">
    <h2>New composition</h2>
    <form data-test="create-form" @submit.prevent="create">
      <div class="row">
        <label for="composition-new-name">Name</label>
        <input id="composition-new-name" v-model="newName" required data-test="new-name" />
      </div>
      <div class="row">
        <label for="composition-new-description">What it is</label>
        <textarea
          id="composition-new-description"
          v-model="newDescription"
          rows="2"
          placeholder="Optional"
          data-test="new-description"
        ></textarea>
      </div>
      <div class="row">
        <label for="composition-new-tempo">Tempo (BPM)</label>
        <input
          id="composition-new-tempo"
          v-model="newTempo"
          type="number"
          min="1"
          max="999"
          step="any"
          placeholder="Optional"
          data-test="new-tempo"
        />
      </div>
      <button type="submit" :disabled="!newName.trim()" data-test="create">Create</button>
    </form>
  </div>
</template>
