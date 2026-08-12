<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

// Notes attached to this patch — what the patch is for, what to try next, and
// the waveform captures filed under them.
const props = defineProps({ patchId: { type: [String, Number], required: true } });

const notes = ref([]);
const title = ref('');
const body = ref('');
const error = ref('');
const busy = ref(false);

const asArray = (value) => (Array.isArray(value) ? value : []);

async function load() {
  error.value = '';
  try {
    notes.value = asArray(await api.get(`/api/notes?patch_id=${props.patchId}`));
  } catch (e) {
    error.value = e.message;
  }
}

async function create() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/api/notes', {
      title: title.value.trim() || undefined,
      body: body.value,
      patch_ids: [Number(props.patchId)],
    });
    title.value = '';
    body.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// Detaching leaves the note itself alone — it may be attached to modules too.
async function detach(note) {
  try {
    await api.post(`/api/notes/${note.id}/detach`, { patch_id: Number(props.patchId) });
    notes.value = notes.value.filter((n) => n.id !== note.id);
  } catch (e) {
    error.value = e.message;
  }
}

defineExpose({ load });
onMounted(load);
</script>

<template>
  <div class="panel" data-test="patch-notes">
    <h2>Notes on this patch</h2>
    <p v-if="error" class="error" data-test="patch-notes-error">{{ error }}</p>

    <form @submit.prevent="create">
      <label for="patch-note-title">Title (optional)</label>
      <input id="patch-note-title" v-model="title" data-test="patch-note-title" />
      <label for="patch-note-body">Note</label>
      <textarea id="patch-note-body" v-model="body" data-test="patch-note-body"></textarea>
      <button type="submit" :disabled="busy || !body.trim()" data-test="patch-note-create">
        Add note
      </button>
    </form>

    <p v-if="notes.length === 0" class="muted" data-test="patch-notes-empty">
      Nothing written down about this patch yet.
    </p>

    <div
      v-for="note in notes"
      :key="note.id"
      class="subpanel"
      :data-test="`patch-note-${note.id}`"
    >
      <h3>{{ note.title || `Note #${note.id}` }}</h3>
      <pre class="note-body">{{ note.body }}</pre>
      <div v-for="capture in note.captures || []" :key="capture.id" class="row">
        <img
          v-if="capture.image_hash"
          :src="`/api/captures/${capture.id}/image`"
          :alt="capture.title || `Capture ${capture.id}`"
          style="max-width: 100%; height: auto"
          :data-test="`patch-note-capture-${capture.id}`"
        />
      </div>
      <p v-if="note.modules?.length" class="muted">
        Also about:
        <span v-for="m in note.modules" :key="m.id">{{ m.manufacturer }} {{ m.name }} </span>
      </p>
      <button class="danger" :data-test="`patch-note-detach-${note.id}`" @click="detach(note)">
        Detach from patch
      </button>
    </div>
  </div>
</template>
