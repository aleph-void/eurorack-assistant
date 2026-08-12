<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { useAuthStore } from '../stores/auth.js';

const props = defineProps({ id: { type: String, required: true } });

const auth = useAuthStore();
const module = ref(null);
const error = ref('');
const uploadError = ref('');
const uploading = ref(false);
const docName = ref('');

// Uploads need a label; 'manual' is reserved for the shared auto-found manual.
const docNameValid = computed(() => {
  const name = docName.value.trim();
  return name !== '' && name.toLowerCase() !== 'manual';
});

const TYPE_LABELS = {
  input_jack: 'Input jacks',
  output_jack: 'Output jacks',
  knob: 'Knobs',
  slider: 'Sliders',
  button: 'Buttons',
  toggle: 'Toggles',
  switch: 'Switches',
  display: 'Displays',
  other: 'Other',
};

const grouped = computed(() => {
  if (!module.value?.components) return [];
  const groups = new Map();
  for (const c of module.value.components) {
    if (!groups.has(c.type)) groups.set(c.type, []);
    groups.get(c.type).push(c);
  }
  return [...groups.entries()].map(([type, components]) => ({
    type,
    label: TYPE_LABELS[type] || type,
    components,
  }));
});

function voltageRange(c) {
  if (c.voltage_min === null && c.voltage_max === null) return '—';
  const min = c.voltage_min === null ? '?' : `${c.voltage_min}V`;
  const max = c.voltage_max === null ? '?' : `${c.voltage_max}V`;
  return `${min} … ${max}`;
}

async function load() {
  try {
    module.value = await api.get(`/api/modules/${props.id}`);
  } catch (e) {
    error.value = e.message;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

async function uploadDocument(file) {
  uploadError.value = '';
  uploading.value = true;
  try {
    const data_base64 = await fileToBase64(file);
    await api.post(`/api/modules/${props.id}/manuals`, {
      name: docName.value.trim(),
      filename: file.name,
      data_base64,
    });
    docName.value = '';
    await load();
  } catch (e) {
    uploadError.value = e.message;
  } finally {
    uploading.value = false;
  }
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  if (file) await uploadDocument(file);
  event.target.value = '';
}

async function removeDocument(doc) {
  uploadError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/manuals/${doc.id}`);
    await load();
  } catch (e) {
    uploadError.value = e.message;
  }
}

// ---- notes ----
const noteBody = ref('');
const noteTarget = ref('module'); // 'module' or a component id
const noteError = ref('');

function componentName(componentId) {
  return module.value?.components?.find((c) => c.id === componentId)?.name || `#${componentId}`;
}

async function createNote() {
  noteError.value = '';
  try {
    const payload = { body: noteBody.value };
    if (noteTarget.value === 'module') payload.module_ids = [Number(props.id)];
    else payload.component_ids = [Number(noteTarget.value)];
    await api.post('/api/notes', payload);
    noteBody.value = '';
    noteTarget.value = 'module';
    await load();
  } catch (e) {
    noteError.value = e.message;
  }
}

async function detachNote(note) {
  noteError.value = '';
  try {
    const payload = note.component_id
      ? { component_id: note.component_id }
      : { module_id: Number(props.id) };
    await api.post(`/api/notes/${note.id}/detach`, payload);
    await load();
  } catch (e) {
    noteError.value = e.message;
  }
}

defineExpose({ uploadDocument });
onMounted(load);
</script>

<template>
  <p><RouterLink to="/modules">← All modules</RouterLink></p>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="module">
    <h1>{{ module.manufacturer }} {{ module.name }}</h1>
    <p>
      <span class="badge" :class="module.manual_status">manual: {{ module.manual_status }}</span>
      &nbsp;
      <span class="badge" :class="module.analysis_status">
        analysis: {{ module.analysis_status }}
      </span>
    </p>

    <div v-if="module.summary" class="panel" data-test="summary">
      <h2>Summary</h2>
      <p style="white-space: pre-wrap">{{ module.summary }}</p>
    </div>

    <div class="panel" data-test="documents">
      <h2>Documents</h2>
      <table v-if="module.manuals?.length">
        <thead>
          <tr>
            <th>Name</th>
            <th>File</th>
            <th>Kind</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in module.manuals" :key="doc.id" :data-test="`doc-${doc.id}`">
            <td>{{ doc.name }}</td>
            <td>
              <a :href="`/api/manuals/${doc.hash}`" target="_blank" rel="noopener">
                {{ doc.original_name || `${doc.hash}.pdf` }}
              </a>
            </td>
            <td>
              <span class="badge" :class="doc.user_id === null ? 'found' : 'pending'">
                {{ doc.user_id === null ? 'shared manual' : 'your document' }}
              </span>
            </td>
            <td>
              <button
                v-if="doc.user_id !== null"
                class="danger"
                style="margin: 0"
                :data-test="`delete-doc-${doc.id}`"
                @click="removeDocument(doc)"
              >
                Remove
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">No documents yet.</p>
      <label for="doc-name">Attach an additional PDF (visible only to you)</label>
      <div class="row">
        <input
          id="doc-name"
          v-model="docName"
          placeholder="Document name (not 'manual')"
          data-test="doc-name"
        />
        <input
          id="doc-upload"
          type="file"
          accept="application/pdf"
          data-test="doc-upload"
          :disabled="uploading || !docNameValid"
          @change="onFileChosen"
        />
      </div>
      <p v-if="uploadError" class="error" data-test="upload-error">{{ uploadError }}</p>
    </div>

    <div class="panel" data-test="notes">
      <h2>Your notes</h2>
      <p class="muted">Notes are private to you. Manage and reuse them on the
        <RouterLink to="/notes">Notes</RouterLink> page.</p>
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

    <div v-for="group in grouped" :key="group.type" class="panel" :data-test="`group-${group.type}`">
      <h2>{{ group.label }}</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th v-if="group.type.endsWith('_jack')">Voltage range</th>
            <th v-if="group.type.endsWith('_jack')">Polarity</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in group.components" :key="c.id">
            <td>{{ c.name }}</td>
            <td>{{ c.description || '—' }}</td>
            <td v-if="group.type.endsWith('_jack')">{{ voltageRange(c) }}</td>
            <td v-if="group.type.endsWith('_jack')">{{ c.polarity || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="module.components && module.components.length === 0" class="muted">
      No components yet — the manual hasn't been analyzed.
    </p>
  </template>
</template>
