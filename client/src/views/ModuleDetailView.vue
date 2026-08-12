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

const NORMALIZATION_KIND_LABELS = {
  input: 'from input',
  output: 'from output',
  internal: 'internal signal',
};

// Human-readable source of a normalled connection: another jack on the
// module, or an internal signal with no panel component.
function normalizationSource(n) {
  return n.source_component_id ? componentName(n.source_component_id) : n.source_label;
}

// ---- manually recording normalled connections ----
const normTarget = ref(''); // component id
const normSource = ref(''); // component id, or 'internal' for a free-text signal
const normSourceLabel = ref('');
const normDescription = ref('');
const normError = ref('');

// Normalled signals always land on an input; they come from another jack or
// an internal signal.
const inputJacks = computed(
  () => module.value?.components?.filter((c) => c.type === 'input_jack') || []
);
const jacks = computed(
  () => module.value?.components?.filter((c) => c.type.endsWith('_jack')) || []
);
const normValid = computed(() => {
  if (!normTarget.value || !normSource.value) return false;
  if (normSource.value === 'internal') return normSourceLabel.value.trim() !== '';
  return Number(normSource.value) !== Number(normTarget.value);
});

async function createNormalization() {
  normError.value = '';
  try {
    const payload = { target_component_id: Number(normTarget.value) };
    if (normSource.value === 'internal') payload.source_label = normSourceLabel.value.trim();
    else payload.source_component_id = Number(normSource.value);
    if (normDescription.value.trim()) payload.description = normDescription.value.trim();
    await api.post(`/api/modules/${props.id}/normalizations`, payload);
    normTarget.value = '';
    normSource.value = '';
    normSourceLabel.value = '';
    normDescription.value = '';
    await load();
  } catch (e) {
    normError.value = e.message;
  }
}

async function removeNormalization(n) {
  normError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/normalizations/${n.id}`);
    await load();
  } catch (e) {
    normError.value = e.message;
  }
}

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
    <p v-if="module.racks?.length" data-test="racks">
      In {{ module.racks.length === 1 ? 'rack' : 'racks' }}:
      {{ module.racks.map((r) => `${r.name} (×${r.quantity})`).join(', ') }}
      — <RouterLink to="/racks">manage racks</RouterLink>
    </p>

    <div v-if="module.summary" class="panel" data-test="summary">
      <h2>Summary</h2>
      <p style="white-space: pre-wrap">{{ module.summary }}</p>
    </div>

    <div v-if="module.components?.length" class="panel" data-test="normalizations">
      <h2>Normalled connections</h2>
      <p class="muted">
        Default connections that exist until a cable is patched into the target input —
        they are part of the signal path even with nothing plugged in.
      </p>
      <table v-if="module.normalizations?.length">
        <thead>
          <tr>
            <th>Input</th>
            <th>Normalled to</th>
            <th>Kind</th>
            <th>Description</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in module.normalizations" :key="n.id" :data-test="`normalization-${n.id}`">
            <td>{{ componentName(n.target_component_id) }}</td>
            <td>{{ normalizationSource(n) }}</td>
            <td>{{ NORMALIZATION_KIND_LABELS[n.kind] || n.kind }}</td>
            <td>{{ n.description || '—' }}</td>
            <td>
              <button
                class="danger"
                style="margin: 0"
                :data-test="`delete-normalization-${n.id}`"
                @click="removeNormalization(n)"
              >
                Remove
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">No normalled connections recorded for this module.</p>

      <form @submit.prevent="createNormalization">
        <div class="row">
          <div>
            <label for="norm-target">Input</label>
            <select id="norm-target" v-model="normTarget" data-test="norm-target">
              <option value="" disabled>Select an input…</option>
              <option v-for="c in inputJacks" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div>
            <label for="norm-source">Normalled to</label>
            <select id="norm-source" v-model="normSource" data-test="norm-source">
              <option value="" disabled>Select a source…</option>
              <option v-for="c in jacks" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.type === 'input_jack' ? 'input' : 'output' }})
              </option>
              <option value="internal">Internal / unlisted signal…</option>
            </select>
          </div>
          <div v-if="normSource === 'internal'">
            <label for="norm-source-label">Signal name</label>
            <input
              id="norm-source-label"
              v-model="normSourceLabel"
              placeholder="e.g. internal oscillator"
              data-test="norm-source-label"
            />
          </div>
          <div style="flex: 2">
            <label for="norm-description">Description (optional)</label>
            <input id="norm-description" v-model="normDescription" data-test="norm-description" />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!normValid" data-test="norm-create">
              Add
            </button>
          </div>
        </div>
        <p v-if="normError" class="error" data-test="norm-error">{{ normError }}</p>
      </form>
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
              <a
                :href="`/api/manuals/${doc.hash}/export`"
                :data-test="`export-doc-${doc.id}`"
                style="margin-right: 0.6rem"
              >
                Export
              </a>
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
