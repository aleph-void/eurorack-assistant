<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { useDevicesStore } from '../stores/devices.js';
import { useLazyPanel } from '../lazyPanel.js';

// The oscilloscope side of a patch: which pane is watching which jack, and
// capturing what they show. Mapping is derived from the patch itself, so the
// usual flow is one click on "Map channels automatically" — the per-channel
// dropdowns are for the cases the patch cannot explain (a scope plugged into
// something the patch does not know about).
const props = defineProps({
  patchId: { type: [String, Number], required: true },
  modules: { type: Array, default: () => [] },
});
const emit = defineEmits(['captured']);

// Built the first time it is opened (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const devices = useDevicesStore();
const channels = ref([]);
const suggestion = ref(null);
const captures = ref([]);
const clips = ref([]);
const tuner = ref([]);
const error = ref('');
const status = ref('');
const busy = ref(false);
const captionDraft = ref({});
const captureTitle = ref('');
const clipTitle = ref('');
const clipDuration = ref(10);
const clipModuleId = ref('');
const recording = ref(false);

// Override form state, per channel index.
const overrideModule = ref({});
const overrideComponent = ref({});

const connection = computed(() => devices.current);
const connected = computed(() => Boolean(connection.value));

// Recording is offered only when the scope says it can. A device that
// announces no capability list at all is assumed to answer everything.
const canRecord = computed(() => {
  const caps = connection.value?.capabilities;
  return !Array.isArray(caps) || caps.includes('record');
});

const asArray = (value) => (Array.isArray(value) ? value : []);

// Only jacks can be watched; a knob has nothing to show.
const jacksOf = (patchModuleId) => {
  const module = props.modules.find((m) => m.id === Number(patchModuleId));
  return asArray(module?.components).filter((c) => String(c.type).endsWith('_jack'));
};

const moduleLabel = (pm) =>
  pm ? pm.label || `${pm.manufacturer} ${pm.module_name}`.trim() : '(unknown module)';

// The modules a clip can be attached to: patch instances that still point at
// a live module record, one entry per module however often it is racked.
const clipModules = computed(() => {
  const seen = new Map();
  for (const pm of props.modules) {
    if (pm.module_id && !seen.has(pm.module_id)) seen.set(pm.module_id, pm);
  }
  return [...seen.values()];
});

// Every channel a capture could take: what the device announced, plus any the
// patch has a mapping for. Named by the mapping where there is one, since a
// jack name says more than "Ch 3".
const captureChannels = computed(() => {
  const indices = new Set();
  const count = Number(connection.value?.audio_device?.channel_count) || 0;
  for (let i = 0; i < count; i += 1) indices.add(i);
  for (const c of asArray(connection.value?.channels)) {
    if (Number.isInteger(c?.index)) indices.add(c.index);
  }
  for (const c of channels.value) {
    if (Number.isInteger(c?.channel_index)) indices.add(c.channel_index);
  }
  const mapped = new Map(channels.value.map((c) => [c.channel_index, c]));
  const announced = new Map(asArray(connection.value?.channels).map((c) => [c.index, c]));
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const map = mapped.get(index);
      return {
        index,
        name: map?.label || map?.component_name || announced.get(index)?.name || null,
      };
    });
});

// Which of them this capture takes. All of them to begin with; a channel the
// user unticks stays unticked as the map is reloaded, and one that appears
// later (a scope with more inputs connects) starts ticked like the rest.
const chosenChannels = ref([]);
watch(
  captureChannels,
  (list, previous) => {
    const known = new Set(asArray(previous).map((c) => c.index));
    const kept = new Set(chosenChannels.value);
    chosenChannels.value = list
      .map((c) => c.index)
      .filter((index) => !known.has(index) || kept.has(index));
  },
  { immediate: true }
);

const allChosen = computed(
  () => captureChannels.value.length > 0 && chosenChannels.value.length === captureChannels.value.length
);

function chooseAll(on) {
  chosenChannels.value = on ? captureChannels.value.map((c) => c.index) : [];
}

async function load() {
  error.value = '';
  try {
    const state = await api.get(`/api/scope/patches/${props.patchId}`);
    channels.value = asArray(state?.channels);
    suggestion.value = state?.suggestion ?? null;
    const list = await api.get(`/api/captures?patch_id=${props.patchId}`);
    captures.value = asArray(list);
    const clipList = await api.get(`/api/clips?patch_id=${props.patchId}`);
    clips.value = asArray(clipList);
  } catch (e) {
    error.value = e.message;
  }
}

async function automap() {
  error.value = '';
  status.value = '';
  busy.value = true;
  try {
    const result = await api.post(`/api/scope/patches/${props.patchId}/automap`, {
      connection_id: connection.value?.id,
    });
    channels.value = asArray(result?.channels);
    status.value =
      result.matched_by === 'none'
        ? 'No audio interface in this patch matched the connected device — map the channels by hand below.'
        : `Mapped against ${result.interface ? moduleLabel(result.interface) : 'the patch'}` +
          (result.labels_pushed ? ' and pushed the names to the scope.' : '.');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function saveOverride(index) {
  error.value = '';
  const patchModuleId = overrideModule.value[index];
  const componentId = overrideComponent.value[index];
  if (!patchModuleId || !componentId) return;
  try {
    const row = await api.put(`/api/scope/patches/${props.patchId}/channels/${index}`, {
      patch_module_id: Number(patchModuleId),
      component_id: Number(componentId),
    });
    const idx = channels.value.findIndex((c) => c.channel_index === index);
    if (idx === -1) channels.value.push(row);
    else channels.value[idx] = row;
  } catch (e) {
    error.value = e.message;
  }
}

async function clearChannel(index) {
  const ok = await dialog.confirm({
    title: 'Clear channel',
    message: `Clear what scope channel ${index + 1} is watching?`,
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/scope/patches/${props.patchId}/channels/${index}`);
    channels.value = channels.value.filter((c) => c.channel_index !== index);
  } catch (e) {
    error.value = e.message;
  }
}

async function readTuner() {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.post(`/api/scope/patches/${props.patchId}/tuner`, {
      connection_id: connection.value?.id,
    });
    tuner.value = asArray(result?.channels);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function capture() {
  error.value = '';
  status.value = '';
  // Only send a channel list when there is one to send: with no channels to
  // choose from the server picks for itself, and an empty tick list would
  // otherwise read as that same "you choose".
  const picked = [...chosenChannels.value].sort((a, b) => a - b);
  if (captureChannels.value.length > 0 && picked.length === 0) {
    error.value = 'Pick at least one channel to capture.';
    return;
  }
  busy.value = true;
  try {
    const created = await api.post(`/api/scope/patches/${props.patchId}/captures`, {
      connection_id: connection.value?.id,
      title: captureTitle.value.trim() || undefined,
      channels: picked.length > 0 ? picked : undefined,
    });
    captureTitle.value = '';
    status.value = 'Captured — filed under this patch’s notes.';
    captures.value = [created, ...captures.value];
    // The note the capture created belongs in the notes panel too.
    emit('captured', created);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// Record a short clip of the ticked channels and attach it to a module —
// the one the select names, or (left on the default) whichever module the
// server finds feeding the first recorded pane.
async function record() {
  error.value = '';
  status.value = '';
  const picked = [...chosenChannels.value].sort((a, b) => a - b);
  if (captureChannels.value.length > 0 && picked.length === 0) {
    error.value = 'Pick at least one channel to record.';
    return;
  }
  recording.value = true;
  try {
    const created = await api.post(`/api/scope/patches/${props.patchId}/clips`, {
      connection_id: connection.value?.id,
      channels: picked.length > 0 ? picked : undefined,
      duration_seconds: Number(clipDuration.value) || undefined,
      module_id: clipModuleId.value ? Number(clipModuleId.value) : undefined,
      title: clipTitle.value.trim() || undefined,
    });
    clipTitle.value = '';
    clips.value = [created, ...clips.value];
    const owner = clipModules.value.find((pm) => pm.module_id === created.module_id);
    status.value = `Recorded — the clip is on ${
      owner ? `${moduleLabel(owner)}’s` : 'the module’s'
    } Videos page.`;
  } catch (e) {
    error.value = e.message;
  } finally {
    recording.value = false;
  }
}

async function removeClip(clip) {
  const ok = await dialog.confirm({
    title: 'Delete clip',
    message: 'Delete this clip? It also disappears from the module’s Videos page.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/clips/${clip.id}`);
    clips.value = clips.value.filter((c) => c.id !== clip.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function saveCaption(capture) {
  try {
    const updated = await api.put(`/api/captures/${capture.id}`, {
      caption: captionDraft.value[capture.id] ?? '',
    });
    const idx = captures.value.findIndex((c) => c.id === capture.id);
    if (idx !== -1) captures.value[idx] = updated;
  } catch (e) {
    error.value = e.message;
  }
}

async function removeCapture(capture) {
  const ok = await dialog.confirm({
    title: 'Delete capture',
    message: 'Delete this capture?',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/captures/${capture.id}`);
    captures.value = captures.value.filter((c) => c.id !== capture.id);
    emit('captured', null);
  } catch (e) {
    error.value = e.message;
  }
}

// A capture channel's tuner reading, as one line.
function reading(channel) {
  const parts = [];
  if (channel.note_name) {
    const cents = channel.cents === null || channel.cents === undefined ? null : Math.round(channel.cents);
    parts.push(cents === null ? channel.note_name : `${channel.note_name} ${cents >= 0 ? '+' : ''}${cents}¢`);
  }
  if (channel.frequency) parts.push(`${Number(channel.frequency).toFixed(2)} Hz`);
  if (channel.signal_type === 'cv' && channel.voltage !== null && channel.voltage !== undefined) {
    parts.push(`${Number(channel.voltage).toFixed(3)} V`);
  }
  return parts.length === 0 ? '—' : parts.join(', ');
}

onMounted(load);
// Reconnecting a scope makes the suggestion meaningful again.
watch(connected, (isConnected) => {
  if (isConnected) load();
});
</script>

<template>
  <details class="panel" data-test="scope-panel" @toggle="onToggle">
    <summary>
      <h2>Oscilloscope</h2>
      <span class="summary-count">
        {{ connected ? 'connected' : 'no scope' }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
<p v-if="!connected" class="muted" data-test="scope-disconnected">
        No oscilloscope is connected.
        <RouterLink to="/devices">Link one</RouterLink> and it will appear here.
      </p>
      <p v-else class="muted" data-test="scope-connected">
        Connected: <strong>{{ connection.name }}</strong>
        <span v-if="connection.audio_device?.name"> — {{ connection.audio_device.name }}</span>
        <span v-if="connection.audio_device?.channel_count">
          ({{ connection.audio_device.channel_count }} channels)
        </span>
      </p>

      <p v-if="error" class="error" data-test="scope-error">{{ error }}</p>
      <p v-if="status" class="ok" data-test="scope-status">{{ status }}</p>

      <div class="actions spaced">
        <button :disabled="!connected || busy" data-test="scope-automap" @click="automap">
          Map channels automatically
        </button>
        <button :disabled="!connected || busy" data-test="scope-tuner" @click="readTuner">
          Read tuner now
        </button>
      </div>

      <p
        v-if="suggestion && suggestion.matched_by === 'none' && connected"
        class="muted"
        data-test="scope-no-match"
      >
        This patch has no module matching the connected audio device, so channels have to be
        mapped by hand.
      </p>

      <div v-if="channels.length > 0" class="table-wrap">
        <table data-test="scope-channels">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Watching</th>
              <th>Showing</th>
              <th>Type</th>
              <th>Set by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="channel in channels"
              :key="channel.channel_index"
              :data-test="`scope-channel-${channel.channel_index}`"
            >
              <td data-label="Channel">{{ channel.channel_index + 1 }}</td>
              <td data-label="Watching">{{ channel.component_name || '—' }}</td>
              <td data-label="Showing">{{ channel.label || '—' }}</td>
              <td data-label="Type">{{ channel.signal_type || '—' }}</td>
              <td data-label="Set by">
                <span class="badge" :class="channel.source === 'manual' ? 'found' : 'pending'">
                  {{ channel.source }}
                </span>
              </td>
              <td>
                <button
                  class="danger"
                  :data-test="`scope-clear-${channel.channel_index}`"
                  @click="clearChannel(channel.channel_index)"
                >
                  Clear
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details v-if="connected" class="expander" data-test="scope-override">
        <summary>Map a channel by hand</summary>
        <div class="expander-body">
          <div
            v-for="index in connection.audio_device?.channel_count || channels.length || 0"
            :key="index"
            class="row"
          >
            <span class="shrink">Ch {{ index }}</span>
            <select
              v-model="overrideModule[index - 1]"
              :data-test="`scope-override-module-${index - 1}`"
            >
              <option value="">Module…</option>
              <option v-for="pm in modules" :key="pm.id" :value="pm.id">
                {{ moduleLabel(pm) }}
              </option>
            </select>
            <select
              v-model="overrideComponent[index - 1]"
              :data-test="`scope-override-jack-${index - 1}`"
            >
              <option value="">Jack…</option>
              <option v-for="jack in jacksOf(overrideModule[index - 1])" :key="jack.id" :value="jack.id">
                {{ jack.name }}
              </option>
            </select>
            <button
              class="shrink"
              :data-test="`scope-override-save-${index - 1}`"
              @click="saveOverride(index - 1)"
            >
              Set
            </button>
          </div>
        </div>
      </details>

      <div v-if="tuner.length > 0" class="subpanel" data-test="scope-tuner-readings">
        <h3>Tuner</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Channel</th><th>Reading</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in tuner" :key="row.index">
                <td data-label="Channel">{{ (row.index ?? 0) + 1 }}</td>
                <td data-label="Reading">{{ reading(row.tuning || row) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="subpanel">
        <h3>Capture a waveform</h3>
        <div v-if="captureChannels.length > 0" class="channel-picker" data-test="capture-channels">
          <div class="row">
            <span class="shrink muted">Channels to capture</span>
            <button
              class="shrink"
              type="button"
              data-test="capture-channels-all"
              @click="chooseAll(!allChosen)"
            >
              {{ allChosen ? 'None' : 'All' }}
            </button>
          </div>
          <div class="channel-checks">
            <label v-for="c in captureChannels" :key="c.index" class="inline-check">
              <input
                v-model="chosenChannels"
                type="checkbox"
                :value="c.index"
                :data-test="`capture-channel-${c.index}`"
              />
              Ch {{ c.index + 1 }}<span v-if="c.name" class="muted"> — {{ c.name }}</span>
            </label>
          </div>
        </div>
        <div class="row">
          <input
            v-model="captureTitle"
            placeholder="Title (optional)"
            data-test="capture-title"
          />
          <button
            class="shrink"
            :disabled="!connected || busy"
            data-test="scope-capture"
            @click="capture"
          >
            Capture waveform + tuner
          </button>
        </div>
        <p class="muted">
          The image and the tuner reading taken with it are stored as a note on this patch, and
          can be attached to a question afterwards.
          <span v-if="captureChannels.length > 0">
            Only the ticked channels are asked for, so a scope with more inputs than the patch
            uses does not fill the picture with flat lines.
          </span>
        </p>
      </div>

      <div class="subpanel" data-test="clip-panel">
        <h3>Record a clip</h3>
        <p v-if="connected && !canRecord" class="muted" data-test="clip-unsupported">
          The connected oscilloscope does not support recording clips.
        </p>
        <template v-else>
          <div class="row">
            <div class="shrink">
              <label for="clip-duration">Seconds (1–30)</label>
              <input
                id="clip-duration"
                v-model="clipDuration"
                type="number"
                min="1"
                max="30"
                data-test="clip-duration"
              />
            </div>
            <div>
              <label for="clip-module">Attach to</label>
              <select id="clip-module" v-model="clipModuleId" data-test="clip-module">
                <option value="">Module feeding the first recorded pane</option>
                <option v-for="pm in clipModules" :key="pm.module_id" :value="pm.module_id">
                  {{ moduleLabel(pm) }}
                </option>
              </select>
            </div>
          </div>
          <div class="row">
            <input v-model="clipTitle" placeholder="Title (optional)" data-test="clip-title" />
            <button
              class="shrink"
              :disabled="!connected || busy || recording"
              data-test="scope-record"
              @click="record"
            >
              {{ recording ? 'Recording…' : 'Record clip' }}
            </button>
          </div>
          <p class="muted">
            The ticked channels above are recorded for a few seconds and the clip is attached to
            a module — it appears on that module’s Videos page, next to its YouTube videos.
          </p>
        </template>

        <!-- Clips carry a video each, so all but the one just taken stay
             folded away. -->
        <details
          v-for="(clip, i) in clips"
          :key="clip.id"
          class="expander"
          :open="i === 0"
          :data-test="`clip-${clip.id}`"
        >
          <summary>
            <h3>{{ clip.title || `Clip #${clip.id}` }}</h3>
            <span class="summary-count">
              {{ new Date(clip.captured_at).toLocaleString() }}
            </span>
          </summary>
          <div class="expander-body">
            <p class="muted">
              <span v-if="clip.device_name">{{ clip.device_name }}</span>
              <span v-if="clip.duration_seconds"> · {{ Math.round(clip.duration_seconds) }}s</span>
              <span v-if="clip.module_id">
                · on
                <RouterLink :to="`/modules/${clip.module_id}/videos`">
                  the module’s Videos page
                </RouterLink>
              </span>
            </p>
            <video
              controls
              preload="metadata"
              :src="`/api/clips/${clip.id}/video`"
              style="max-width: 100%; height: auto"
              :data-test="`clip-video-${clip.id}`"
            ></video>
            <div class="row">
              <button
                class="danger shrink"
                :data-test="`clip-delete-${clip.id}`"
                @click="removeClip(clip)"
              >
                Delete
              </button>
            </div>
          </div>
        </details>
      </div>

      <!-- Captures carry a waveform image each, so all but the one just
           taken stay folded away. -->
      <details
        v-for="(row, i) in captures"
        :key="row.id"
        class="expander"
        :open="i === 0"
        :data-test="`capture-${row.id}`"
      >
        <summary>
          <h3>{{ row.title || `Capture #${row.id}` }}</h3>
          <span class="summary-count">
            {{ new Date(row.captured_at).toLocaleString() }}
          </span>
        </summary>
        <div class="expander-body">
          <p class="muted">
            <span v-if="row.device_name">{{ row.device_name }}</span>
            <span v-if="row.audio_device_name"> · {{ row.audio_device_name }}</span>
          </p>
          <img
            v-if="row.image_hash"
            :src="`/api/captures/${row.id}/image`"
            :alt="row.title || `Capture ${row.id}`"
            style="max-width: 100%; height: auto"
            :data-test="`capture-image-${row.id}`"
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
                    {{ channel.label || channel.component_name || '—' }}
                    <span v-if="channel.source_description" class="muted">
                      ({{ channel.source_description }})
                    </span>
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
              :data-test="`capture-caption-${row.id}`"
              @input="captionDraft[row.id] = $event.target.value"
            />
            <button class="shrink" :data-test="`capture-save-${row.id}`" @click="saveCaption(row)">
              Save
            </button>
            <button
              class="danger shrink"
              :data-test="`capture-delete-${row.id}`"
              @click="removeCapture(row)"
            >
              Delete
            </button>
          </div>
        </div>
      </details>
    </div>
  </details>
</template>

<style scoped>
.channel-picker {
  margin-bottom: 0.6rem;
}
.channel-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.2rem;
  margin-top: 0.4rem;
}
/* A channel carries the jack it watches, which is longer than "Ch 3" and
   must be allowed to wrap. */
.channel-checks .inline-check {
  white-space: normal;
}
</style>
