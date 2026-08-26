<script setup>
// The recordings of ONE record — a module or a patch — and the three ways to
// make one.
//
// A synth is a thing you listen to, and until now nothing in the app held the
// sound: a patch was cables and settings, a module was jacks and a manual.
// This is where "here is what it actually does" lives, and it is the same
// list and the same three buttons on both pages, so it is one panel — only
// the word for the thing and the query key differ (the same shape
// QuestionsPanel.vue takes over the two record kinds).
//
// The three ways in, in the order a person reaches for them:
//   - RECORD, straight from whatever the browser is listening to. One click
//     from noticing a patch is worth keeping.
//   - UPLOAD, for the take that came out of a DAW.
//   - ASK THE OSCILLOSCOPE, which already has a cable in it (`record_audio`
//     in docs/oscilloscope-protocol.md). Offered only while a device that
//     can do it is on the line, so the button is never a button that fails.
//
// The bytes go up as base64 in JSON, like every other upload here.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';

const props = defineProps({
  // 'module' or 'patch' — the query key and the wording.
  kind: { type: String, required: true },
  recordId: { type: String, required: true },
});

const recordings = ref([]);
const loading = ref(true);
const listError = ref('');
const busy = ref(false);
const uploadError = ref('');
// Which recording's waveform is open. One at a time: the picture is a
// thousand pixels tall and the list is a list.
const shownWaveform = ref(null);
const editing = ref(null);
const editTitle = ref('');
const editCaption = ref('');

const noun = computed(() => (props.kind === 'patch' ? 'patch' : 'module'));
// The scope routes are addressed by the plural, which is not the noun plus an
// s in one of the two cases.
const scopePath = computed(() => (props.kind === 'patch' ? 'patches' : 'modules'));
const ownerBody = computed(() => ({ [`${noun.value}_id`]: Number(props.recordId) }));

// ---- the list ----

async function load() {
  loading.value = true;
  listError.value = '';
  try {
    recordings.value = await api.get(`/api/audio?${noun.value}_id=${props.recordId}`);
  } catch (e) {
    listError.value = e.message;
    recordings.value = [];
  } finally {
    loading.value = false;
  }
}

// ---- what the oscilloscope can do ----
// Asked once per page: the button to record from the scope only appears when
// something that can record is actually connected. A device that announces no
// capabilities at all is taken at its word and offered.
const scopeDevice = ref(null);
async function findScope() {
  try {
    const state = await api.get(`/api/scope/${scopePath.value}/${props.recordId}`, {
      quiet: true,
    });
    scopeDevice.value =
      (state.devices ?? []).find(
        (d) => !Array.isArray(d.capabilities) || d.capabilities.includes('record_audio')
      ) ?? null;
  } catch {
    scopeDevice.value = null;
  }
}

onMounted(() => {
  load();
  findScope();
});
watch(
  () => props.recordId,
  () => {
    shownWaveform.value = null;
    editing.value = null;
    load();
    findScope();
  }
);

// ---- uploading ----

// A File or Blob as the base64 the API takes. FileReader rather than
// arrayBuffer + btoa: a five-megabyte take spread over String.fromCharCode
// blows the argument limit.
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

async function send(blob, { filename = null, source = 'upload' }) {
  busy.value = true;
  uploadError.value = '';
  try {
    const created = await api.post('/api/audio', {
      ...ownerBody.value,
      source,
      filename,
      data_base64: await toBase64(blob),
    });
    recordings.value = [created, ...recordings.value];
    return created;
  } catch (e) {
    uploadError.value = e.message;
    return null;
  } finally {
    busy.value = false;
  }
}

const fileInput = ref(null);

async function onFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  await send(file, { filename: file.name, source: 'upload' });
  // Let the same file be picked again after a failure.
  if (fileInput.value) fileInput.value.value = '';
}

// ---- recording in the browser ----
//
// MediaRecorder gives webm/opus in every browser that has it, which is one of
// the formats the server stores. A machine without it (or without permission)
// simply does not get this button; the other two ways in still work.
const canRecordHere =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  Boolean(navigator?.mediaDevices?.getUserMedia);
const recorder = ref(null);
const recordingHere = ref(false);
const recordError = ref('');

async function startRecording() {
  recordError.value = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    recordError.value = `Could not open the microphone or input: ${e.message}`;
    toast.error(recordError.value);
    return;
  }
  const chunks = [];
  const mr = new window.MediaRecorder(stream);
  mr.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  mr.onstop = async () => {
    // The tracks are released whatever happened to the take: a page holding
    // the input open is a page nothing else can record through.
    for (const track of stream.getTracks()) track.stop();
    recordingHere.value = false;
    recorder.value = null;
    if (chunks.length === 0) return;
    await send(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), {
      filename: null,
      source: 'browser',
    });
  };
  mr.start();
  recorder.value = mr;
  recordingHere.value = true;
}

function stopRecording() {
  if (recorder.value && recorder.value.state !== 'inactive') recorder.value.stop();
}

// A take still running when the page goes would hold the input open forever.
onUnmounted(stopRecording);

// ---- recording from the oscilloscope ----

const scopeSeconds = ref('15');
const scopeBusy = ref(false);

async function recordFromScope() {
  scopeBusy.value = true;
  uploadError.value = '';
  try {
    const created = await api.post(`/api/scope/${scopePath.value}/${props.recordId}/audio`, {
      duration_seconds: Number(scopeSeconds.value) || 15,
      connection_id: scopeDevice.value?.id,
    });
    recordings.value = [created, ...recordings.value];
  } catch (e) {
    uploadError.value = e.message;
  } finally {
    scopeBusy.value = false;
  }
}

// ---- editing and removing ----

function startEdit(recording) {
  editing.value = recording.id;
  editTitle.value = recording.title ?? '';
  editCaption.value = recording.caption ?? '';
}

async function saveEdit(recording) {
  try {
    const updated = await api.put(`/api/audio/${recording.id}`, {
      title: editTitle.value,
      caption: editCaption.value,
    });
    recordings.value = recordings.value.map((r) => (r.id === updated.id ? updated : r));
    editing.value = null;
  } catch {
    /* api.js has already said so */
  }
}

async function remove(recording) {
  try {
    await api.delete(`/api/audio/${recording.id}`);
    recordings.value = recordings.value.filter((r) => r.id !== recording.id);
    if (shownWaveform.value === recording.id) shownWaveform.value = null;
  } catch {
    /* api.js has already said so */
  }
}

// ---- how a recording reads ----

const SOURCE_LABELS = { upload: 'Uploaded', browser: 'Recorded here', device: 'Oscilloscope' };
const sourceLabel = (recording) => SOURCE_LABELS[recording.source] ?? recording.source;

function lengthOf(recording) {
  const value = recording.duration_seconds;
  if (value == null) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${value.toFixed(1)}s`;
}

// Peak is the number that decides whether a recording is usable at all: a
// modular runs ten volts peak to peak, and an input expecting line level
// clips on it. Say so where it happened.
function levelOf(recording) {
  if (recording.peak_dbfs == null) return '—';
  const peak = `${recording.peak_dbfs.toFixed(1)} dBFS peak`;
  return recording.peak_dbfs >= -0.1 ? `${peak} — clipping` : peak;
}

const formatDate = (value) => (value ? new Date(value).toLocaleString() : '');
</script>

<template>
  <details open class="panel" data-test="audio-recordings">
    <summary>
      <h2>Recordings</h2>
      <span class="summary-count">
        {{ recordings.length }} {{ recordings.length === 1 ? 'recording' : 'recordings' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        What this {{ noun }} actually sounds like. A recording can be attached to a question,
        where it travels as the waveform and spectrogram drawn from it plus its measured levels
        — no assistant can listen to the file itself.
      </p>

      <div class="actions record-actions">
        <button
          v-if="canRecordHere && !recordingHere"
          type="button"
          data-test="record-here"
          :disabled="busy"
          @click="startRecording"
        >
          Record from this device
        </button>
        <button
          v-if="recordingHere"
          type="button"
          class="danger"
          data-test="stop-recording"
          @click="stopRecording"
        >
          Stop recording
        </button>

        <label class="file-button">
          <span>Upload a file</span>
          <input
            ref="fileInput"
            type="file"
            accept="audio/*"
            data-test="audio-file"
            :disabled="busy"
            @change="onFile"
          />
        </label>

        <template v-if="scopeDevice">
          <label :for="`scope-seconds-${recordId}`" class="inline-label">Seconds</label>
          <input
            :id="`scope-seconds-${recordId}`"
            v-model="scopeSeconds"
            type="number"
            min="1"
            max="120"
            class="seconds"
            data-test="scope-seconds"
          />
          <button
            type="button"
            class="secondary"
            data-test="record-from-scope"
            :disabled="scopeBusy"
            @click="recordFromScope"
          >
            Record from {{ scopeDevice.name || 'the oscilloscope' }}
          </button>
        </template>
      </div>

      <p v-if="recordingHere" class="muted" data-test="recording-now">Recording…</p>
      <p v-if="recordError" class="error" data-test="record-error">{{ recordError }}</p>
      <p v-if="uploadError" class="error" data-test="audio-error">{{ uploadError }}</p>
      <p v-if="busy" class="muted">Storing the recording…</p>

      <p v-if="listError" class="error" data-test="audio-list-error">{{ listError }}</p>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="recordings.length === 0" class="muted" data-test="no-audio">
        No recordings of this {{ noun }} yet.
      </p>
      <div v-else class="table-wrap">
        <table data-test="audio-table">
          <thead>
            <tr>
              <th>Recording</th>
              <th>Listen</th>
              <th>Length</th>
              <th>Level</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="recording in recordings" :key="recording.id" :data-test="`audio-${recording.id}`">
              <td data-label="Recording">
                <template v-if="editing === recording.id">
                  <input v-model="editTitle" type="text" data-test="audio-title-input" />
                  <textarea
                    v-model="editCaption"
                    rows="2"
                    placeholder="What is happening in it?"
                    data-test="audio-caption-input"
                  ></textarea>
                </template>
                <template v-else>
                  <strong>{{ recording.title || recording.original_name || `Recording ${recording.id}` }}</strong>
                  <p v-if="recording.caption" class="muted">{{ recording.caption }}</p>
                  <p v-if="recording.patch_name && noun === 'module'" class="muted">
                    from {{ recording.patch_name }}
                  </p>
                </template>
              </td>
              <td data-label="Listen">
                <audio controls preload="none" :src="recording.url"></audio>
              </td>
              <td data-label="Length" class="muted">{{ lengthOf(recording) }}</td>
              <td data-label="Level" class="muted">{{ levelOf(recording) }}</td>
              <td data-label="Source" class="muted">
                {{ sourceLabel(recording) }}
                <span class="block">{{ formatDate(recording.recorded_at) }}</span>
              </td>
              <td>
                <div class="actions">
                  <template v-if="editing === recording.id">
                    <button type="button" data-test="audio-save" @click="saveEdit(recording)">
                      Save
                    </button>
                    <button type="button" class="secondary" @click="editing = null">Cancel</button>
                  </template>
                  <template v-else>
                    <button
                      v-if="recording.waveform_url"
                      type="button"
                      class="secondary"
                      data-test="audio-waveform-toggle"
                      @click="shownWaveform = shownWaveform === recording.id ? null : recording.id"
                    >
                      {{ shownWaveform === recording.id ? 'Hide waveform' : 'Waveform' }}
                    </button>
                    <button
                      type="button"
                      class="secondary"
                      data-test="audio-edit"
                      @click="startEdit(recording)"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      class="danger"
                      data-test="audio-delete"
                      @click="remove(recording)"
                    >
                      Delete
                    </button>
                  </template>
                </div>
              </td>
            </tr>
            <tr v-if="shownWaveform" :key="`waveform-${shownWaveform}`">
              <td colspan="6">
                <img
                  class="waveform"
                  loading="lazy"
                  decoding="async"
                  :src="recordings.find((r) => r.id === shownWaveform)?.waveform_url"
                  alt="Waveform above the spectrogram of the recording"
                  data-test="audio-waveform"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </details>
</template>

<style scoped>
.record-actions {
  align-items: center;
  flex-wrap: wrap;
}

.inline-label {
  margin: 0;
}

.seconds {
  width: 5rem;
}

/* A file input styled as the button beside it, so "upload" and "record" read
   as the two ways of doing one thing rather than a button and a form. */
.file-button input[type='file'] {
  display: none;
}

.file-button span {
  display: inline-block;
  padding: 0.45rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.waveform {
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

audio {
  max-width: 100%;
  width: 16rem;
}

.block {
  display: block;
}
</style>
