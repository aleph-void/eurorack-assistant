<script setup>
import { ref, toRef } from 'vue';
import { api } from '../../api.js';
import { useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName } = useModuleFacts(toRef(props, 'module'));

// ---- notes ----
const noteBody = ref('');
const noteTarget = ref('module'); // 'module' or a component id
const noteError = ref('');

async function createNote() {
  noteError.value = '';
  try {
    const payload = { body: noteBody.value };
    if (noteTarget.value === 'module') payload.module_ids = [Number(props.moduleId)];
    else payload.component_ids = [Number(noteTarget.value)];
    await api.post('/api/notes', payload);
    noteBody.value = '';
    noteTarget.value = 'module';
    emit('reload');
  } catch (e) {
    noteError.value = e.message;
  }
}

async function detachNote(note) {
  noteError.value = '';
  try {
    const payload = note.component_id
      ? { component_id: note.component_id }
      : { module_id: Number(props.moduleId) };
    await api.post(`/api/notes/${note.id}/detach`, payload);
    emit('reload');
  } catch (e) {
    noteError.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="notes">
    <summary>
      <h2>Your notes</h2>
      <span class="summary-count">
        {{ module.notes?.length || 0 }}
        {{ module.notes?.length === 1 ? 'note' : 'notes' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
Notes are private to you. Manage and reuse them on the
        <RouterLink to="/notes">Notes</RouterLink> page.
</p>
      <div
        v-for="note in module.notes || []"
        :key="`${note.id}-${note.component_id ?? 'm'}`"
        :data-test="`note-${note.id}-${note.component_id ?? 'module'}`"
        style="border-bottom: 1px solid var(--border); padding: 0.4rem 0"
      >
        <span class="badge" :class="note.component_id ? 'pending' : 'found'">
          {{ note.component_id ? componentName(note.component_id) : 'module' }}
        </span>
        <strong v-if="note.title"> {{ note.title }}: </strong>
        <span style="white-space: pre-wrap"> {{ note.body }}</span>
        <a href="#" :data-test="`detach-note-${note.id}-${note.component_id ?? 'module'}`" @click.prevent="detachNote(note)">✕</a>
      </div>
      <p v-if="!module.notes?.length" class="muted">No notes on this module yet.</p>

      <form @submit.prevent="createNote">
        <div class="row">
          <div>
            <label for="note-target">Attach to</label>
            <select id="note-target" v-model="noteTarget" data-test="note-target">
              <option value="module">This module</option>
              <option v-for="c in module.components || []" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.type }})
              </option>
            </select>
          </div>
          <div style="flex: 2">
            <label for="note-body">New note</label>
            <input id="note-body" v-model="noteBody" data-test="note-body" />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!noteBody.trim()" data-test="note-create">
              Add
            </button>
          </div>
        </div>
        <p v-if="noteError" class="error" data-test="note-error">{{ noteError }}</p>
      </form>
    </div>
  </details>
</template>
