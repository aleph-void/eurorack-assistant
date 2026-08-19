<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';

// Scan a YouTube channel for videos about the selected rack's modules, then
// import the ones the user ticks into the per-module video pipeline
// (download + techniques analysis), exactly as if each link had been pasted
// on its module's page.
const props = defineProps({
  rackId: { type: Number, required: true },
});

const url = ref('');
const scanning = ref(false);
const importing = ref(false);
const error = ref('');
const notice = ref('');
const result = ref(null);
// Selection keys are `${module_id}:${video_id}` — the same video can be
// imported for two different modules it matched.
const selected = ref(new Set());

watch(
  () => props.rackId,
  () => {
    url.value = '';
    error.value = '';
    notice.value = '';
    result.value = null;
    selected.value = new Set();
  }
);

const key = (module, video) => `${module.module_id}:${video.video_id}`;

const selectable = computed(() =>
  (result.value?.modules ?? []).flatMap((module) =>
    module.videos.filter((video) => !video.already_attached).map((video) => key(module, video))
  )
);
const matchCount = computed(() =>
  (result.value?.modules ?? []).reduce((sum, module) => sum + module.videos.length, 0)
);

async function scan() {
  if (!url.value.trim()) return;
  error.value = '';
  notice.value = '';
  result.value = null;
  selected.value = new Set();
  scanning.value = true;
  try {
    result.value = await api.post(`/api/racks/${props.rackId}/videos/channel-scan`, {
      url: url.value.trim(),
    });
    // Everything importable starts ticked: 'select none' is one click away,
    // and the common case is wanting the channel's coverage of the rack.
    selected.value = new Set(selectable.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    scanning.value = false;
  }
}

function toggle(module, video) {
  const k = key(module, video);
  const next = new Set(selected.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selected.value = next;
}

const selectAll = () => (selected.value = new Set(selectable.value));
const selectNone = () => (selected.value = new Set());

async function importSelected() {
  const picks = (result.value?.modules ?? []).flatMap((module) =>
    module.videos
      .filter((video) => !video.already_attached && selected.value.has(key(module, video)))
      .map((video) => ({ module_id: module.module_id, video_id: video.video_id, title: video.title }))
  );
  if (!picks.length) return;
  error.value = '';
  notice.value = '';
  importing.value = true;
  try {
    const res = await api.post(`/api/racks/${props.rackId}/videos/import`, { videos: picks });
    // Flag what was just queued so the list reflects it without a re-scan.
    for (const module of result.value?.modules ?? []) {
      for (const video of module.videos) {
        if (selected.value.has(key(module, video))) video.already_attached = true;
      }
    }
    selected.value = new Set();
    notice.value =
      `Queued ${res.queued} video(s) for download and analysis` +
      (res.skipped ? ` (${res.skipped} already attached)` : '') +
      ' — progress is on the Jobs page and each module’s Videos section.';
  } catch (e) {
    error.value = e.message;
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <details class="panel" data-test="channel-scan">
    <summary>
      <h2>Find channel videos</h2>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Paste a YouTube channel and the channel's uploads are searched for videos about the
        modules in this rack. Pick the ones you want and each is downloaded, watched by the
        model, and summarized onto its module — the same pipeline as attaching a link by hand.
      </p>
      <div class="row">
        <div style="flex: 2">
          <label for="channel-url">YouTube channel</label>
          <input
            id="channel-url"
            v-model="url"
            placeholder="https://www.youtube.com/@channel"
            data-test="channel-url"
            :disabled="scanning"
            @keyup.enter="scan"
          />
        </div>
        <div class="shrink" style="align-self: end">
          <button
            style="margin: 0"
            :disabled="scanning || !url.trim()"
            data-test="channel-scan-button"
            @click="scan"
          >
            {{ scanning ? 'Scanning…' : 'Scan channel' }}
          </button>
        </div>
      </div>
      <p v-if="error" class="error" data-test="channel-scan-error">{{ error }}</p>
      <p v-if="notice" class="success" data-test="channel-scan-notice">{{ notice }}</p>

      <template v-if="result">
        <p class="muted" data-test="channel-scan-summary">
          Scanned {{ result.scanned }} video(s) on
          <a :href="result.channel.url" target="_blank" rel="noopener">{{ result.channel.title }}</a>
          — {{ matchCount }} match(es) across {{ result.modules.length }} module(s).
        </p>
        <p v-if="result.source === 'yt-dlp'" class="muted" data-test="channel-scan-keyless">
          Scanned without a YouTube API key, so only video titles were matched — a video that
          mentions a module only in its description is not found. An admin can add a key on the
          Config page for faster, fuller scans.
        </p>
        <template v-if="result.modules.length">
          <div class="actions spaced">
            <button
              class="secondary"
              :disabled="importing || selectable.length === 0"
              data-test="select-all"
              @click="selectAll"
            >
              Select all
            </button>
            <button
              class="secondary"
              :disabled="importing || selected.size === 0"
              data-test="select-none"
              @click="selectNone"
            >
              Select none
            </button>
            <button
              :disabled="importing || selected.size === 0"
              data-test="import-selected"
              @click="importSelected"
            >
              {{ importing ? 'Importing…' : `Import ${selected.size} selected` }}
            </button>
          </div>
          <div
            v-for="module in result.modules"
            :key="module.module_id"
            class="scan-module"
            :data-test="`scan-module-${module.module_id}`"
          >
            <h3>
              {{ module.manufacturer }} {{ module.name }}
              <span class="muted">— {{ module.videos.length }} video(s)</span>
            </h3>
            <ul class="scan-videos">
              <li v-for="video in module.videos" :key="video.video_id">
                <label class="inline-check">
                  <input
                    type="checkbox"
                    :checked="video.already_attached || selected.has(key(module, video))"
                    :disabled="video.already_attached || importing"
                    :data-test="`pick-${module.module_id}-${video.video_id}`"
                    @change="toggle(module, video)"
                  />
                  <a :href="video.url" target="_blank" rel="noopener">{{ video.title }}</a>
                  <span v-if="video.published_at" class="muted">
                    ({{ video.published_at.slice(0, 10) }})
                  </span>
                  <span v-if="video.matched_on === 'description'" class="muted">
                    — matched in description
                  </span>
                  <span
                    v-if="video.already_attached"
                    class="badge complete"
                    :data-test="`attached-${module.module_id}-${video.video_id}`"
                  >
                    attached
                  </span>
                </label>
              </li>
            </ul>
          </div>
        </template>
        <p v-else class="muted" data-test="channel-scan-empty">
          None of the channel's videos mention a module in this rack.
        </p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.scan-module { margin: 0.8rem 0; }
.scan-module h3 { margin: 0 0 0.3rem; }
.scan-videos { list-style: none; margin: 0; padding: 0; }
.scan-videos li { padding: 0.15rem 0; }
.scan-videos .inline-check { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
</style>
