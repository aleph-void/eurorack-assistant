<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { useDevicesStore } from '../stores/devices.js';

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

const devices = useDevicesStore();
const channels = ref([]);
const suggestion = ref(null);
const captures = ref([]);
const tuner = ref([]);
const error = ref('');
const status = ref('');
const busy = ref(false);
const captionDraft = ref({});
const captureTitle = ref('');

// Override form state, per channel index.
const overrideModule = ref({});
const overrideComponent = ref({});

const connection = computed(() => devices.current);
const connected = computed(() => Boolean(connection.value));

const asArray = (value) => (Array.isArray(value) ? value : []);

// Only jacks can be watched; a knob has nothing to show.
const jacksOf = (patchModuleId) => {
  const module = props.modules.find((m) => m.id === Number(patchModuleId));
  return asArray(module?.components).filter((c) => String(c.type).endsWith('_jack'));
};

const moduleLabel = (pm) =>
  pm ? pm.label || `${pm.manufacturer} ${pm.module_name}`.trim() : '(unknown module)';

async function load() {
  error.value = '';
  try {
    const state = await api.get(`/api/scope/patches/${props.patchId}`);
    channels.value = asArray(state?.channels);
    suggestion.value = state?.suggestion ?? null;
    const list = await api.get(`/api/captures?patch_id=${props.patchId}`);
    captures.value = asArray(list);
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
  busy.value = true;
  try {
    const created = await api.post(`/api/scope/patches/${props.patchId}/captures`, {
      connection_id: connection.value?.id,
      title: captureTitle.value.trim() || undefined,
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
  if (!confirm('Delete this capture?')) return;
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
  <div class="panel" data-test="scope-panel">
    <h2>Oscilloscope</h2>

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

    <div class="row">
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

    <table v-if="channels.length > 0" data-test="scope-channels">
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
          <td>{{ channel.channel_index + 1 }}</td>
          <td>{{ channel.component_name || '—' }}</td>
          <td>{{ channel.label || '—' }}</td>
          <td>{{ channel.signal_type || '—' }}</td>
          <td>
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

    <details v-if="connected" data-test="scope-override">
      <summary>Map a channel by hand</summary>
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
    </details>

    <div v-if="tuner.length > 0" class="subpanel" data-test="scope-tuner-readings">
      <h3>Tuner</h3>
      <table>
        <thead>
          <tr><th>Channel</th><th>Reading</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in tuner" :key="row.index">
            <td>{{ (row.index ?? 0) + 1 }}</td>
            <td>{{ reading(row.tuning || row) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="subpanel">
      <h3>Capture a waveform</h3>
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
      </p>
    </div>

    <div
      v-for="capture in captures"
      :key="capture.id"
      class="subpanel"
      :data-test="`capture-${capture.id}`"
    >
      <h3>{{ capture.title || `Capture #${capture.id}` }}</h3>
      <p class="muted">
        {{ new Date(capture.captured_at).toLocaleString() }}
        <span v-if="capture.device_name"> · {{ capture.device_name }}</span>
        <span v-if="capture.audio_device_name"> · {{ capture.audio_device_name }}</span>
      </p>
      <img
        v-if="capture.image_hash"
        :src="`/api/captures/${capture.id}/image`"
        :alt="capture.title || `Capture ${capture.id}`"
        style="max-width: 100%; height: auto"
        :data-test="`capture-image-${capture.id}`"
      />
      <table v-if="capture.channels?.length">
        <thead>
          <tr><th>Channel</th><th>Showing</th><th>Reading</th></tr>
        </thead>
        <tbody>
          <tr v-for="channel in capture.channels" :key="channel.id">
            <td>{{ channel.channel_index + 1 }}</td>
            <td>
              {{ channel.label || channel.component_name || '—' }}
              <span v-if="channel.source_description" class="muted">
                ({{ channel.source_description }})
              </span>
            </td>
            <td>{{ reading(channel) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="row">
        <input
          :value="captionDraft[capture.id] ?? capture.caption ?? ''"
          placeholder="Caption"
          :data-test="`capture-caption-${capture.id}`"
          @input="captionDraft[capture.id] = $event.target.value"
        />
        <button class="shrink" :data-test="`capture-save-${capture.id}`" @click="saveCaption(capture)">
          Save
        </button>
        <button
          class="danger shrink"
          :data-test="`capture-delete-${capture.id}`"
          @click="removeCapture(capture)"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
</template>
