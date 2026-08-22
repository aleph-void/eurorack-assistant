<script setup>
import { computed, ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import ShareButton from '../ShareButton.vue';
import { fileToBase64 } from '../../files.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const uploadError = ref('');
const uploading = ref(false);
const docName = ref('');
// The file waits here between being chosen and being sent, so the name it
// suggests can be read and corrected first.
const docFile = ref(null);
const docInput = ref(null);

// Uploads need a label; 'manual' is reserved for the shared auto-found manual.
const docNameValid = computed(() => {
  const name = docName.value.trim();
  return name !== '' && name.toLowerCase() !== 'manual';
});

// Whether the upload should ride along with the module's (re)analysis.
const docScope = ref(false);

// Mark or unmark a document as in scope for analysis. The checkbox drives
// this directly; the row is patched in place so the page doesn't reload.
async function toggleScope(doc, value) {
  uploadError.value = '';
  try {
    await api.put(`/api/modules/${props.moduleId}/manuals/${doc.id}/scope`, {
      analysis_scope: value,
    });
    doc.analysis_scope = value;
  } catch (e) {
    uploadError.value = e.message;
    emit('reload');
  }
}

async function uploadDocument(file = docFile.value) {
  if (!file) {
    uploadError.value = 'Choose a PDF to attach.';
    return;
  }
  if (!docNameValid.value) {
    uploadError.value = "Give the document a name — anything but 'manual'.";
    return;
  }
  uploadError.value = '';
  uploading.value = true;
  try {
    const data_base64 = await fileToBase64(file);
    await api.post(`/api/modules/${props.moduleId}/manuals`, {
      name: docName.value.trim(),
      filename: file.name,
      data_base64,
      analysis_scope: docScope.value,
    });
    docName.value = '';
    docScope.value = false;
    docFile.value = null;
    if (docInput.value) docInput.value.value = '';
    emit('reload');
  } catch (e) {
    uploadError.value = e.message;
  } finally {
    uploading.value = false;
  }
}

// Picking the file comes first and names the document after it — 'extra.pdf'
// becomes 'extra' — because the file is usually already named what the
// document is. Nothing is sent until Upload, so that name can be replaced.
function onFileChosen(event) {
  const file = event.target.files?.[0] || null;
  uploadError.value = '';
  docFile.value = file;
  if (file) docName.value = file.name.replace(/\.pdf$/i, '').trim();
}

async function removeDocument(doc) {
  const ok = await dialog.confirm({
    title: 'Remove document',
    message: `Remove '${doc.name}'? The uploaded file and its searchable text are deleted.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  uploadError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/manuals/${doc.id}`);
    emit('reload');
  } catch (e) {
    uploadError.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="documents">
    <summary>
      <h2>Documents</h2>
      <span class="summary-count">
        {{ module.manuals?.length || 0 }}
        {{ module.manuals?.length === 1 ? 'document' : 'documents' }}
      </span>
    </summary>
    <div class="panel-body">
      <div v-if="module.manuals?.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>File</th>
              <th>Kind</th>
              <th>Text</th>
              <th title="Checked documents are the ones submitted when the module is (re)analyzed. The manual arrives checked; uncheck it to leave it out.">
                Analysis
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="doc in module.manuals" :key="doc.id" :data-test="`doc-${doc.id}`">
              <td data-label="Name">{{ doc.name }}</td>
              <td data-label="File">
                <a :href="`/api/manuals/${doc.hash}`" target="_blank" rel="noopener">
                  {{ doc.original_name || `${doc.hash}.pdf` }}
                </a>
              </td>
              <!-- Three kinds now: the manual every user gets, your own
                   upload, and an upload another user shared with you. -->
              <td data-label="Kind">
                <span class="badge" :class="doc.user_id === null ? 'found' : 'pending'">
                  <template v-if="doc.user_id === null">shared manual</template>
                  <template v-else-if="doc.shared_by">from {{ doc.shared_by }}</template>
                  <template v-else>your document</template>
                </span>
              </td>
              <!-- The manual as a readable page, once the extraction job has
                   turned the PDF into markdown. -->
              <td data-label="Text">
                <RouterLink
                  v-if="doc.has_text"
                  :to="`/manuals/${doc.hash}`"
                  :data-test="`read-doc-${doc.id}`"
                >
                  Read
                </RouterLink>
                <span v-else class="muted" :data-test="`no-text-doc-${doc.id}`">not yet</span>
              </td>
              <!-- In scope for analysis: submitted on every (re)analysis.
                   The manual itself arrives marked and can be unmarked
                   like anything else. A document somebody shared with you
                   is theirs to mark, not yours. -->
              <td data-label="Analysis">
                <input
                  type="checkbox"
                  :checked="doc.analysis_scope"
                  :disabled="Boolean(doc.shared_by)"
                  :data-test="`scope-doc-${doc.id}`"
                  :aria-label="`Include ${doc.name} in analysis`"
                  @change="toggleScope(doc, $event.target.checked)"
                />
              </td>
              <td class="actions-cell">
                <div class="actions nowrap">
                  <a :href="`/api/manuals/${doc.hash}/export`" :data-test="`export-doc-${doc.id}`">
                    Export
                  </a>
                  <!-- Your own uploads only: the shared manual is nobody's to
                       hand out, and a document you were given is not yours to
                       pass on or remove. -->
                  <template v-if="doc.user_id !== null && !doc.shared_by">
                    <ShareButton :id="doc.id" type="document" :label="doc.name" small />
                    <button
                      class="danger"
                      :data-test="`delete-doc-${doc.id}`"
                      @click="removeDocument(doc)"
                    >
                      Remove
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No documents yet.</p>
      <div class="row">
        <div>
          <label for="doc-upload">Attach an additional PDF (visible only to you)</label>
          <input
            id="doc-upload"
            ref="docInput"
            type="file"
            accept="application/pdf"
            data-test="doc-upload"
            :disabled="uploading"
            @change="onFileChosen"
          />
        </div>
        <div>
          <label for="doc-name">Document name (not 'manual')</label>
          <input
            id="doc-name"
            v-model="docName"
            placeholder="e.g. calibration guide"
            data-test="doc-name"
          />
        </div>
        <div class="shrink">
          <label for="doc-scope" style="white-space: nowrap">
            <input
              id="doc-scope"
              v-model="docScope"
              type="checkbox"
              data-test="doc-scope"
              :disabled="uploading"
            />
            Use in analysis
          </label>
        </div>
        <div class="shrink">
          <button
            style="margin: 0"
            :disabled="uploading || !docFile || !docNameValid"
            data-test="doc-send"
            @click="uploadDocument()"
          >
            {{ uploading ? 'Uploading…' : 'Upload' }}
          </button>
        </div>
      </div>
      <p v-if="docFile && !docNameValid" class="muted" data-test="doc-name-hint">
        The name came from the file — change it to anything but 'manual', which belongs to the
        manual the app found.
      </p>
      <p v-if="uploadError" class="error" data-test="upload-error">{{ uploadError }}</p>
    </div>
  </details>
</template>
