<script setup>
import { computed, ref } from 'vue';
import { api } from '../../api.js';

// Search YouTube for tutorials about this module, then queue the ones the
// user ticks through the per-video pipeline (download + techniques
// analysis) — exactly as if each link had been pasted into the attach box.
// The server builds the query from the module's manufacturer and name.
const props = defineProps({
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['imported']);

const searching = ref(false);
const importing = ref(false);
const error = ref('');
const notice = ref('');
const result = ref(null);
const selected = ref(new Set());

const selectable = computed(() =>
  (result.value?.videos ?? []).filter((video) => !video.already_attached).map((video) => video.video_id)
);

// One function for both buttons: a fresh search replaces the list, a 'load
// more' (page set) appends the next page to it.
async function search(page = null) {
  error.value = '';
  notice.value = '';
  searching.value = true;
  try {
    const res = await api.post(
      `/api/modules/${props.moduleId}/videos/search`,
      page ? { page } : {}
    );
    if (page && result.value) {
      // Search pages can overlap at the edges; a video the list already
      // shows is dropped rather than listed twice.
      const seen = new Set(result.value.videos.map((video) => video.video_id));
      result.value.videos.push(...res.videos.filter((video) => !seen.has(video.video_id)));
      result.value.next_page = res.next_page;
    } else {
      result.value = res;
      selected.value = new Set();
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    searching.value = false;
  }
}

function toggle(video) {
  const next = new Set(selected.value);
  if (next.has(video.video_id)) next.delete(video.video_id);
  else next.add(video.video_id);
  selected.value = next;
}

const selectAll = () => (selected.value = new Set(selectable.value));
const selectNone = () => (selected.value = new Set());

// What an earlier import of this video came to, as a badge: done, still in
// the queue, or failed (and therefore re-selectable as a retry).
function attachedLabel(video) {
  if (!video.attached_status) return '';
  if (video.attached_status === 'complete') return 'analyzed';
  if (video.attached_status === 'failed') return 'failed last time';
  return 'in progress';
}

async function importSelected() {
  const picks = (result.value?.videos ?? [])
    .filter((video) => !video.already_attached && selected.value.has(video.video_id))
    .map((video) => ({ video_id: video.video_id, title: video.title }));
  if (!picks.length) return;
  error.value = '';
  notice.value = '';
  importing.value = true;
  try {
    const res = await api.post(`/api/modules/${props.moduleId}/videos/import`, { videos: picks });
    // Flag what was just queued so the list reflects it without a re-search.
    for (const video of result.value?.videos ?? []) {
      if (selected.value.has(video.video_id)) {
        video.already_attached = true;
        video.attached_status = 'pending';
      }
    }
    selected.value = new Set();
    notice.value =
      `Queued ${res.queued} video(s) for download and analysis` +
      (res.skipped ? ` (${res.skipped} already attached)` : '') +
      ' — each appears in the list above and fills in as its job finishes.';
    emit('imported');
  } catch (e) {
    error.value = e.message;
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <details class="video-search" data-test="video-search">
    <summary>Find tutorials on YouTube</summary>
    <p class="muted">
      Search YouTube for videos about this module. Pick the ones you want and each is
      downloaded, watched by the model, and summarized above — nothing is selected until you
      tick it. Searching again shows what each earlier import came to.
    </p>
    <button
      class="secondary"
      :disabled="searching || importing"
      data-test="video-search-button"
      @click="search()"
    >
      {{ searching ? 'Searching…' : result ? 'Search again' : 'Search YouTube' }}
    </button>
    <p v-if="error" class="error" data-test="video-search-error">{{ error }}</p>
    <p v-if="notice" class="success" data-test="video-search-notice">{{ notice }}</p>

    <template v-if="result">
      <p class="muted" data-test="video-search-summary">
        {{ result.videos.length }} result(s) for “{{ result.query }}”.
      </p>
      <p v-if="result.source === 'yt-dlp'" class="muted" data-test="video-search-keyless">
        Searched without a YouTube API key, so results carry no upload dates and may be
        slower to fetch. An admin can add a key on the Config page.
      </p>
      <template v-if="result.videos.length">
        <div class="actions spaced">
          <button
            class="secondary"
            :disabled="importing || selectable.length === 0"
            data-test="search-select-all"
            @click="selectAll"
          >
            Select all
          </button>
          <button
            class="secondary"
            :disabled="importing || selected.size === 0"
            data-test="search-select-none"
            @click="selectNone"
          >
            Select none
          </button>
          <button
            :disabled="importing || selected.size === 0"
            data-test="search-import-selected"
            @click="importSelected"
          >
            {{ importing ? 'Importing…' : `Import ${selected.size} selected` }}
          </button>
        </div>
        <ul class="search-videos">
          <li v-for="video in result.videos" :key="video.video_id">
            <label class="inline-check">
              <input
                type="checkbox"
                :checked="video.already_attached || selected.has(video.video_id)"
                :disabled="video.already_attached || importing"
                :data-test="`search-pick-${video.video_id}`"
                @change="toggle(video)"
              />
              <a :href="video.url" target="_blank" rel="noopener">{{ video.title }}</a>
              <span v-if="video.channel" class="muted">{{ video.channel }}</span>
              <span v-if="video.published_at" class="muted">
                ({{ video.published_at.slice(0, 10) }})
              </span>
              <span
                v-if="video.attached_status"
                class="badge"
                :class="video.attached_status"
                :data-test="`search-attached-${video.video_id}`"
              >
                {{ attachedLabel(video) }}
              </span>
            </label>
          </li>
        </ul>
        <button
          v-if="result.next_page"
          class="secondary"
          :disabled="searching || importing"
          data-test="video-search-more"
          @click="search(result.next_page)"
        >
          {{ searching ? 'Loading…' : 'Load more results' }}
        </button>
      </template>
      <p v-else class="muted" data-test="video-search-empty">
        YouTube found nothing for this module.
      </p>
    </template>
  </details>
</template>

<style scoped>
.video-search { margin-top: 1rem; }
.video-search > summary { cursor: pointer; }
.search-videos {
  list-style: none;
  margin: 0.5rem 0;
  padding: 0;
  max-height: 24rem;
  overflow-y: auto;
}
.search-videos li { padding: 0.15rem 0; }
.search-videos .inline-check { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
</style>
