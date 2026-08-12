<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';

const notes = ref([]);
const modules = ref([]);
const error = ref('');
const title = ref('');
const body = ref('');
const busy = ref(false);

// Per-note attach form state: { moduleId, componentId, components }
const attachForms = reactive({});

async function load() {
  try {
    [notes.value, modules.value] = await Promise.all([
      api.get('/api/notes'),
      api.get('/api/modules'),
    ]);
  } catch (e) {
    error.value = e.message;
  }
}

function attachForm(noteId) {
  if (!attachForms[noteId]) {
    attachForms[noteId] = { moduleId: '', componentId: '', components: [] };
  }
  return attachForms[noteId];
}

async function onModuleChosen(noteId) {
  const form = attachForm(noteId);
  form.componentId = '';
  form.components = [];
  if (form.moduleId) {
    try {
      const detail = await api.get(`/api/modules/${form.moduleId}`);
      form.components = detail.components || [];
    } catch (e) {
      error.value = e.message;
    }
  }
}

async function createNote() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/api/notes', { title: title.value, body: body.value });
    title.value = '';
    body.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function attach(note) {
  const form = attachForm(note.id);
  error.value = '';
  try {
    const payload = form.componentId
      ? { component_ids: [Number(form.componentId)] }
      : { module_ids: [Number(form.moduleId)] };
    await api.post(`/api/notes/${note.id}/attach`, payload);
    form.moduleId = '';
    form.componentId = '';
    form.components = [];
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function detachModule(note, module) {
  await api.post(`/api/notes/${note.id}/detach`, { module_id: module.id });
  await load();
}

async function detachComponent(note, component) {
  await api.post(`/api/notes/${note.id}/detach`, { component_id: component.id });
  await load();
}

async function removeNote(note) {
  if (!confirm('Delete this note everywhere it is attached?')) return;
  await api.delete(`/api/notes/${note.id}`);
  await load();
}

onMounted(load);
</script>

<template>
  <h1>Your notes</h1>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>

  <div class="panel">
    <h2>New note</h2>
    <form @submit.prevent="createNote">
      <label for="note-title">Title (optional)</label>
      <input id="note-title" v-model="title" data-test="note-title" />
      <label for="note-body">Note</label>
      <textarea id="note-body" v-model="body" data-test="note-body"></textarea>
      <button type="submit" :disabled="busy || !body.trim()" data-test="note-create">
        Create note
      </button>
    </form>
  </div>

  <div
    v-for="note in notes"
    :key="note.id"
    class="panel"
    :data-test="`note-${note.id}`"
  >
    <div class="row" style="align-items: baseline">
      <h2 style="margin: 0">{{ note.title || 'Untitled note' }}</h2>
      <div class="shrink">
        <button class="danger" style="margin: 0" :data-test="`note-delete-${note.id}`" @click="removeNote(note)">
          Delete
        </button>
      </div>
    </div>
    <p style="white-space: pre-wrap">{{ note.body }}</p>

    <p>
      <template v-for="m in note.modules" :key="`m${m.id}`">
        <span class="badge found">
          {{ m.manufacturer }} {{ m.name }}
          <a href="#" @click.prevent="detachModule(note, m)">✕</a>
        </span>
        &nbsp;
      </template>
      <template v-for="c in note.components" :key="`c${c.id}`">
        <span class="badge pending">
          {{ c.module_manufacturer }} {{ c.module_name }} · {{ c.name }}
          <a href="#" @click.prevent="detachComponent(note, c)">✕</a>
        </span>
        &nbsp;
      </template>
      <span v-if="note.modules.length === 0 && note.components.length === 0" class="muted">
        Not attached to anything yet.
      </span>
    </p>

    <div class="row">
      <div>
        <label>Attach to module</label>
        <select
          v-model="attachForm(note.id).moduleId"
          :data-test="`attach-module-${note.id}`"
          @change="onModuleChosen(note.id)"
        >
          <option value="">Choose a module…</option>
          <option v-for="m in modules" :key="m.id" :value="m.id">
            {{ m.manufacturer }} {{ m.name }}
          </option>
        </select>
      </div>
      <div>
        <label>Specific component (optional)</label>
        <select
          v-model="attachForm(note.id).componentId"
          :data-test="`attach-component-${note.id}`"
          :disabled="!attachForm(note.id).moduleId"
        >
          <option value="">Whole module</option>
          <option v-for="c in attachForm(note.id).components" :key="c.id" :value="c.id">
            {{ c.name }} ({{ c.type }})
          </option>
        </select>
      </div>
      <div class="shrink">
        <button
          class="secondary"
          style="margin: 0"
          :disabled="!attachForm(note.id).moduleId"
          :data-test="`attach-${note.id}`"
          @click="attach(note)"
        >
          Attach
        </button>
      </div>
    </div>
  </div>

  <p v-if="notes.length === 0" class="muted">No notes yet.</p>
</template>
