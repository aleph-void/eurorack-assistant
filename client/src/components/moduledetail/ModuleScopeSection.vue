<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { useDevicesStore } from '../../stores/devices.js';
import { useLazyPanel } from '../../lazyPanel.js';
import { isPatchPoint } from '../../panelLayout.js';

// The bench: this module, a cable into the interface, and a scope. A patch's
// Scope page derives what each pane is watching from the patch itself; here
// there is no patch to read, so each pane names one of the module's own jacks
// and that naming is what the capture (or the clip) is stored with. It is
// prefilled from the last take, because a bench session is one cable that
// stays where it is.
const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// The captures carry an image each and the clips a video: none of them should
// load while the section is closed (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const devices = useDevicesStore();
const error = ref('');
const status = ref('');
const busy = ref(false);
const recording = ref(false);
const captureTitle = ref('');
const clipTitle = ref('');
const clipDuration = ref(10);
// Per channel index: the jack it is on, and whether it is CV.
const paneJack = ref({});
const paneCv = ref({});
const chosen = ref([]);
const captionDraft = ref({});

const connection = computed(() => devices.current);
const connected = computed(() => Boolean(connection.value));

// Recording is offered only when the scope says it can. A device that
// announces no capability list at all is assumed to answer everything.
const canRecord = computed(() => {
  const caps = connection.value?.capabilities;
  return !Array.isArray(caps) || caps.includes('record');
});

const moduleLabel = computed(() =>
  `${props.module.manufacturer || ''} ${props.module.name || ''}`.trim()
);

// Only jacks a cable actually goes in can be watched.
const jacks = computed(() =>
  (props.module.components || []).filter(
    (c) => String(c.type).endsWith('_jack') && isPatchPoint(c)
  )
);

const captures = computed(() => props.module.captures || []);
const clips = computed(() => props.module.clips || []);

// Every pane the scope announced, plus any the last take used — a device with
// eight inputs offers eight, and a stored naming for a ninth is still shown.
const remembered = ref([]);
const panes = computed(() => {
  const indices = new Set();
  const count = Number(connection.value?.audio_device?.channel_count) || 0;
  for (let i = 0; i < count; i += 1) indices.add(i);
  for (const c of connection.value?.channels || []) {
    if (Number.isInteger(c?.index)) indices.add(c.index);
  }
  for (const c of remembered.value) {
    if (Number.isInteger(c?.channel_index)) indices.add(c.channel_index);
  }
  return [...indices].sort((a, b) => a - b);
});

// Which of them this take uses. All of them to begin with; a pane the user
// unticks stays unticked as the list is reloaded, and one that appears later
// (a scope with more inputs connects) starts ticked like the rest.
watch(
  panes,
  (list, previous) => {
    const known = new Set(previous || []);
    const kept = new Set(chosen.value);
    chosen.value = list.filter((index) => !known.has(index) || kept.has(index));
  },
  { immediate: true }
);

const allChosen = computed(
  () => panes.value.length > 0 && chosen.value.length === panes.value.length
);

function chooseAll(on) {
  chosen.value = on ? [...panes.value] : [];
}

const jackName = (index) => {
  const id = Number(paneJack.value[index]);
  return jacks.value.find((j) => j.id === id)?.name || null;
};

async function load() {
  error.value = '';
  try {
    const state = await api.get(`/api/scope/modules/${props.moduleId}`);
    remembered.value = Array.isArray(state?.channels) ? state.channels : [];
    for (const channel of remembered.value) {
      if (channel.component_id) paneJack.value[channel.channel_index] = channel.component_id;
      if (channel.signal_type === 'cv') paneCv.value[channel.channel_index] = true;
    }
  } catch (e) {
    error.value = e.message;
  }
}

// What the panes are, as the API takes them: the ticked ones, each carrying
// the jack it is on when the page knows of one. Only sent when there is one
// to send — with no panes to choose from the scope shows what it is showing,
// and an empty list would otherwise read as that same "you choose".
function channelPayload() {
  const picked = [...chosen.value]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      component_id: paneJack.value[index] ? Number(paneJack.value[index]) : undefined,
      signal_type: paneCv.value[index] ? 'cv' : 'audio',
    }));
  return picked.length > 0 ? picked : undefined;
}

function paneProblem() {
  if (panes.value.length > 0 && chosen.value.length === 0) return 'Pick at least one channel.';
  return '';
}

async function capture() {
  error.value = '';
  status.value = '';
  const problem = paneProblem();
  if (problem) {
    error.value = problem;
    return;
  }
  busy.value = true;
  try {
    await api.post(`/api/scope/modules/${props.moduleId}/captures`, {
      connection_id: connection.value?.id,
      title: captureTitle.value.trim() || undefined,
      channels: channelPayload(),
    });
    captureTitle.value = '';
    status.value = 'Captured — filed under a note on this module.';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function record() {
  error.value = '';
  status.value = '';
  const problem = paneProblem();
  if (problem) {
    error.value = problem;
    return;
  }
  recording.value = true;
  try {
    await api.post(`/api/scope/modules/${props.moduleId}/clips`, {
      connection_id: connection.value?.id,
      title: clipTitle.value.trim() || undefined,
      duration_seconds: Number(clipDuration.value) || undefined,
      channels: channelPayload(),
    });
    clipTitle.value = '';
    status.value = 'Recorded — the clip is on this module’s Videos page too.';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  } finally {
    recording.value = false;
  }
}

async function saveCaption(capture_) {
  error.value = '';
  try {
    await api.put(`/api/captures/${capture_.id}`, {
      caption: captionDraft.value[capture_.id] ?? '',
    });
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

async function removeCapture(capture_) {
  const ok = await dialog.confirm({
    title: 'Delete capture',
    message: `Delete '${capture_.title || `Capture #${capture_.id}`}'?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/captures/${capture_.id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

// A capture channel's tuner reading, as one line.
function reading(channel) {
  const parts = [];
  if (channel.note_name) {
    const cents =
      channel.cents === null || channel.cents === undefined ? null : Math.round(channel.cents);
    parts.push(
      cents === null ? channel.note_name : `${channel.note_name} ${cents >= 0 ? '+' : ''}${cents}¢`
    );
  }
  if (channel.frequency) parts.push(`${Number(channel.frequency).toFixed(2)} Hz`);
  if (channel.signal_type === 'cv' && channel.voltage !== null && channel.voltage !== undefined) {
    parts.push(`${Number(channel.voltage).toFixed(3)} V`);
  }
  return parts.length === 0 ? '—' : parts.join(', ');
}

onMounted(load);
// Reconnecting a scope makes the remembered naming meaningful again.
watch(connected, (isConnected) => {
  if (isConnected) load();
});
</script>

<template>
  <details class="panel" open data-test="module-scope" @toggle="onToggle">
    <summary>
      <h2>Oscilloscope</h2>
      <span class="summary-count">{{ connected ? 'connected' : 'no scope' }}</span>
    </summary>
    <div v-if="opened" class="panel-body">
      <p v-if="!connected" class="muted" data-test="module-scope-disconnected">
        No oscilloscope is connected.
        <RouterLink to="/devices">Link one</RouterLink> and it will appear here.
      </p>
      <p v-else class="muted" data-test="module-scope-connected">
        Connected: <strong>{{ connection.name }}</strong>
        <span v-if="connection.audio_device?.name"> — {{ connection.audio_device.name }}</span>
        <span v-if="connection.audio_device?.channel_count">
          ({{ connection.audio_device.channel_count }} channels)
        </span>
      </p>
      <p class="muted">
        Patch {{ moduleLabel || 'this module' }} into your interface, say which jack each pane is
        on, and take a still or a few seconds of video. Captures are filed under a note on this
        module; clips also appear on its
        <RouterLink :to="`/modules/${moduleId}/videos`">Videos page</RouterLink>.
      </p>

      <p v-if="error" class="error" data-test="module-scope-error">{{ error }}</p>
      <p v-if="status" class="ok" data-test="module-scope-status">{{ status }}</p>

      <div class="subpanel">
        <h3>Panes</h3>
        <p v-if="panes.length === 0" class="muted" data-test="module-scope-no-panes">
          The connected scope has not said how many inputs it has — a capture will take whatever
          it is showing.
        </p>
        <template v-else>
          <div class="row">
            <span class="shrink muted">Channels to take</span>
            <button
              class="shrink"
              type="button"
              data-test="module-scope-panes-all"
              @click="chooseAll(!allChosen)"
            >
              {{ allChosen ? 'None' : 'All' }}
            </button>
          </div>
          <div class="table-wrap">
            <table data-test="module-scope-panes">
              <thead>
                <tr>
                  <th></th>
                  <th>Channel</th>
                  <th>Watching</th>
                  <th>CV</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="index in panes" :key="index" :data-test="`module-pane-${index}`">
                  <td>
                    <input
                      v-model="chosen"
                      type="checkbox"
                      :value="index"
                      :aria-label="`Channel ${index + 1}`"
                      :data-test="`module-pane-check-${index}`"
                    />
                  </td>
                  <td data-label="Channel">
                    Ch {{ index + 1 }}
                    <span v-if="jackName(index)" class="muted"> — {{ jackName(index) }}</span>
                  </td>
                  <td data-label="Watching">
                    <select
                      v-model="paneJack[index]"
                      :aria-label="`Jack on channel ${index + 1}`"
                      :data-test="`module-pane-jack-${index}`"
                    >
                      <option value="">Not named</option>
                      <option v-for="jack in jacks" :key="jack.id" :value="jack.id">
                        {{ jack.name }}
                      </option>
                    </select>
                  </td>
                  <td data-label="CV">
                    <input
                      v-model="paneCv[index]"
                      type="checkbox"
                      :aria-label="`Channel ${index + 1} is CV`"
                      :data-test="`module-pane-cv-${index}`"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <div class="subpanel">
        <h3>Capture a waveform</h3>
        <div class="row">
          <input
            v-model="captureTitle"
            placeholder="Title (optional)"
            data-test="module-capture-title"
          />
          <button
            class="shrink"
            :disabled="!connected || busy"
            data-test="module-scope-capture"
            @click="capture"
          >
            Capture waveform + tuner
          </button>
        </div>
      </div>

      <div class="subpanel" data-test="module-clip-panel">
        <h3>Record a clip</h3>
        <p v-if="connected && !canRecord" class="muted" data-test="module-clip-unsupported">
          The connected oscilloscope does not support recording clips.
        </p>
        <template v-else>
          <div class="row">
            <div class="shrink">
              <label for="module-clip-duration">Seconds (1–30)</label>
              <input
                id="module-clip-duration"
                v-model="clipDuration"
                type="number"
                min="1"
                max="30"
                data-test="module-clip-duration"
              />
            </div>
            <input v-model="clipTitle" placeholder="Title (optional)" data-test="module-clip-title" />
            <button
              class="shrink"
              :disabled="!connected || busy || recording"
              data-test="module-scope-record"
              @click="record"
            >
              {{ recording ? 'Recording…' : 'Record clip' }}
            </button>
          </div>
        </template>
      </div>

      <h3>Captures of this module</h3>
      <p v-if="captures.length === 0" class="muted" data-test="no-module-captures">
        No captures yet.
      </p>
      <!-- Captures carry a waveform image each, so all but the newest stay
           folded away. -->
      <details
        v-for="(row, i) in captures"
        :key="row.id"
        class="expander"
        :open="i === 0"
        :data-test="`module-capture-${row.id}`"
      >
        <summary>
          <h3>{{ row.title || `Capture #${row.id}` }}</h3>
          <span class="summary-count">{{ new Date(row.captured_at).toLocaleString() }}</span>
        </summary>
        <div class="expander-body">
          <p class="muted">
            <span v-if="row.device_name">{{ row.device_name }}</span>
            <span v-if="row.audio_device_name"> · {{ row.audio_device_name }}</span>
            <span v-if="row.note_id">
              ·
              <RouterLink :to="`/modules/${moduleId}/notes`">filed under your notes</RouterLink>
            </span>
          </p>
          <img
            v-if="row.image_hash"
            :src="`/api/captures/${row.id}/image`"
            :alt="row.title || `Capture ${row.id}`"
            loading="lazy"
            decoding="async"
            style="max-width: 100%; height: auto"
            :data-test="`module-capture-image-${row.id}`"
          />
          <div v-if="row.channels?.length" class="table-wrap">
            <table>
              <thead>
                <tr><th>Channel</th><th>Showing</th><th>Reading</th></tr>
              </thead>
              <tbody>
                <tr v-for="channel in row.channels" :key="channel.id">
                  <td data-label="Channel">{{ channel.channel_index + 1 }}</td>
                  <td data-label="Showing">
                    {{ channel.component_name || channel.label || '—' }}
                  </td>
                  <td data-label="Reading">{{ reading(channel) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row">
            <input
              :value="captionDraft[row.id] ?? row.caption ?? ''"
              placeholder="Caption"
              :data-test="`module-capture-caption-${row.id}`"
              @input="captionDraft[row.id] = $event.target.value"
            />
            <button
              class="shrink"
              :data-test="`module-capture-save-${row.id}`"
              @click="saveCaption(row)"
            >
              Save
            </button>
            <button
              class="danger shrink"
              :data-test="`module-capture-delete-${row.id}`"
              @click="removeCapture(row)"
            >
              Delete
            </button>
          </div>
        </div>
      </details>

      <p class="muted" data-test="module-scope-clip-count">
        {{ clips.length }} {{ clips.length === 1 ? 'clip' : 'clips' }} recorded of this module —
        they are listed under Scope clips below.
      </p>
    </div>
  </details>
</template>
