<script setup>
import { ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { useLazyPanel } from '../../lazyPanel.js';

// Short oscilloscope recordings attached to this module. A clip is made on a
// patch's Scope page — the scope records the chosen panes for a few seconds
// and the video lands here, next to the module's YouTube videos.
defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// Every clip is a <video>; none of them should load while the section is
// closed (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const error = ref('');
const captionDraft = ref({});

async function saveCaption(clip) {
  error.value = '';
  try {
    await api.put(`/api/clips/${clip.id}`, {
      caption: captionDraft.value[clip.id] ?? '',
    });
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

async function removeClip(clip) {
  const ok = await dialog.confirm({
    title: 'Delete clip',
    message: `Delete '${clip.title || `Clip #${clip.id}`}'?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/clips/${clip.id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

const paneLabel = (c) => c.label || c.component_name || `Channel ${c.channel_index + 1}`;
</script>

<template>
  <details class="panel" data-test="clips" @toggle="onToggle">
    <summary>
      <h2>Scope clips</h2>
      <span class="summary-count">
        {{ module.clips?.length || 0 }}
        {{ module.clips?.length === 1 ? 'clip' : 'clips' }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
      <p class="muted">
        Short recordings from the linked oscilloscope of what this module's signals look like.
        Record one from a patch's Scope page while the module is playing.
      </p>
      <p v-if="error" class="error" data-test="clip-error">{{ error }}</p>
      <p v-if="!module.clips?.length" class="muted" data-test="no-clips">No clips yet.</p>
      <details
        v-for="(clip, i) in module.clips || []"
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
            <span v-if="clip.patch_name"> · recorded on patch “{{ clip.patch_name }}”</span>
          </p>
          <video
            controls
            preload="metadata"
            :src="`/api/clips/${clip.id}/video`"
            style="max-width: 100%; height: auto"
            :data-test="`clip-video-${clip.id}`"
          ></video>
          <div v-if="clip.channels?.length" class="table-wrap">
            <table>
              <thead>
                <tr><th>Pane</th><th>Showing</th></tr>
              </thead>
              <tbody>
                <tr v-for="channel in clip.channels" :key="channel.id">
                  <td data-label="Pane">{{ channel.channel_index + 1 }}</td>
                  <td data-label="Showing">
                    {{ paneLabel(channel) }}
                    <span v-if="channel.source_description" class="muted">
                      ({{ channel.source_description }})
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row">
            <input
              :value="captionDraft[clip.id] ?? clip.caption ?? ''"
              placeholder="Caption"
              :data-test="`clip-caption-${clip.id}`"
              @input="captionDraft[clip.id] = $event.target.value"
            />
            <button class="shrink" :data-test="`clip-save-${clip.id}`" @click="saveCaption(clip)">
              Save
            </button>
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
  </details>
</template>
