<script setup>
import { computed, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import VideoSearchPanel from './VideoSearchPanel.vue';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const videoUrl = ref('');
const videoError = ref('');
const adding = ref(false);

const canAdd = computed(() => videoUrl.value.trim() !== '');

// Attach a YouTube link: the server downloads the video, has the model watch
// it, and keeps only the link and the techniques summary. Re-posting a failed
// video's URL is how a retry works, so the same call serves both buttons.
async function addVideo(url = videoUrl.value.trim()) {
  if (!url) return;
  videoError.value = '';
  adding.value = true;
  try {
    await api.post(`/api/modules/${props.moduleId}/videos`, { url });
    videoUrl.value = '';
    emit('reload');
  } catch (e) {
    videoError.value = e.message;
  } finally {
    adding.value = false;
  }
}

async function removeVideo(video) {
  const ok = await dialog.confirm({
    title: 'Remove video',
    message: `Remove '${video.title || video.url}'? The link and its analysis are deleted.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  videoError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/videos/${video.id}`);
    emit('reload');
  } catch (e) {
    videoError.value = e.message;
  }
}

// The analysis summary is model-written markdown; render it like an answer.
const summaryHtml = (video) => DOMPurify.sanitize(marked.parse(video.summary || ''));

const length = (video) =>
  video.duration_seconds ? `${Math.round(video.duration_seconds / 60)} min` : '';

// The in-flight states, so the row can say the queue is still on it.
const working = (status) => ['pending', 'downloading', 'downloaded', 'analyzing'].includes(status);
</script>

<template>
  <details class="panel" data-test="videos">
    <summary>
      <h2>Videos</h2>
      <span class="summary-count">
        {{ module.videos?.length || 0 }}
        {{ module.videos?.length === 1 ? 'video' : 'videos' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Attach a YouTube video about this module and the model watches it for you: the video is
        downloaded, summarized into the techniques it demonstrates, and deleted — the link and the
        summary stay here.
      </p>
      <div v-if="module.videos?.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Video</th>
              <th>Channel</th>
              <th>Length</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="video in module.videos" :key="video.id">
              <tr :data-test="`video-${video.id}`">
                <td data-label="Video">
                  <a :href="video.url" target="_blank" rel="noopener">
                    {{ video.title || video.url }}
                  </a>
                </td>
                <td data-label="Channel">{{ video.channel }}</td>
                <td data-label="Length">{{ length(video) }}</td>
                <td data-label="Status">
                  <span class="badge" :class="video.status" :data-test="`video-status-${video.id}`">
                    {{ video.status }}
                  </span>
                </td>
                <td class="actions-cell">
                  <div class="actions nowrap">
                    <button
                      v-if="video.status === 'failed'"
                      :disabled="adding"
                      :data-test="`retry-video-${video.id}`"
                      @click="addVideo(video.url)"
                    >
                      Retry
                    </button>
                    <button
                      class="danger"
                      :data-test="`delete-video-${video.id}`"
                      @click="removeVideo(video)"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="video.summary || video.error || working(video.status)">
                <td data-label="Video" colspan="5">
                  <details v-if="video.summary" :data-test="`video-summary-${video.id}`">
                    <summary>Techniques</summary>
                    <!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
                    <div class="answer" v-html="summaryHtml(video)"></div>
                  </details>
                  <p
                    v-else-if="video.error"
                    class="muted"
                    :data-test="`video-error-${video.id}`"
                  >
                    {{ video.error }}
                  </p>
                  <p v-else class="muted" :data-test="`video-working-${video.id}`">
                    The video is being downloaded and analyzed — the summary appears here when the
                    job finishes.
                  </p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No videos yet.</p>
      <div class="row">
        <div>
          <label for="video-url">YouTube link</label>
          <input
            id="video-url"
            v-model="videoUrl"
            placeholder="https://www.youtube.com/watch?v=…"
            data-test="video-url"
            :disabled="adding"
            @keyup.enter="addVideo()"
          />
        </div>
        <div class="shrink">
          <button
            style="margin: 0"
            :disabled="adding || !canAdd"
            data-test="video-send"
            @click="addVideo()"
          >
            {{ adding ? 'Attaching…' : 'Attach' }}
          </button>
        </div>
      </div>
      <p v-if="videoError" class="error" data-test="video-add-error">{{ videoError }}</p>
      <VideoSearchPanel :module-id="moduleId" @imported="emit('reload')" />
    </div>
  </details>
</template>
