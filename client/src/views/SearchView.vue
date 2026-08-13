<script setup>
// Full-text search across the manuals: the shared manual of every module,
// plus the documents you uploaded yourself. Hits come back ranked, each with
// a snippet in which the matched words are wrapped in [[ ]] by the server.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { splitSnippet } from '../snippet.js';

const route = useRoute();
const router = useRouter();

const query = ref('');
const results = ref([]);
const hasMore = ref(false);
const offset = ref(0);
const searched = ref('');
const searching = ref(false);
const error = ref('');

const PAGE = 20;

async function run(nextOffset = 0) {
  const q = query.value.trim();
  if (!q) {
    results.value = [];
    searched.value = '';
    return;
  }
  searching.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ q, limit: String(PAGE), offset: String(nextOffset) });
    const data = await api.get(`/api/manuals/search?${params}`);
    // Paging appends, a fresh search replaces.
    results.value = nextOffset > 0 ? [...results.value, ...data.results] : data.results;
    hasMore.value = data.has_more;
    offset.value = nextOffset;
    searched.value = data.query;
  } catch (e) {
    error.value = e.message;
  } finally {
    searching.value = false;
  }
}

function submit() {
  // The query lives in the URL, so a search can be linked to and survives a
  // reload.
  router.push({ name: 'search', query: query.value.trim() ? { q: query.value.trim() } : {} });
}

const total = computed(() => results.value.length);

watch(
  () => route.query.q,
  (q) => {
    query.value = String(q ?? '');
    run(0);
  }
);

onMounted(() => {
  query.value = String(route.query.q ?? '');
  if (query.value) run(0);
});
</script>

<template>
  <h1>Search manuals</h1>
  <p class="muted">
    Every word of every manual the app has read, including the documents you uploaded — those stay
    private to you. Quote a phrase to require it exactly, and put a minus in front of a word to
    leave it out: <code>"gate output" -midi</code>
  </p>

  <div class="panel">
    <form @submit.prevent="submit">
      <div class="row">
        <input
          v-model="query"
          placeholder="What are you looking for?"
          aria-label="Search manuals"
          data-test="search-input"
        />
        <div class="shrink">
          <button type="submit" style="margin: 0" :disabled="!query.trim()" data-test="search-go">
            Search
          </button>
        </div>
      </div>
    </form>
    <p v-if="error" class="error" data-test="search-error">{{ error }}</p>
  </div>

  <p v-if="searching && total === 0" class="muted" data-test="searching">Searching…</p>
  <p v-else-if="searched && total === 0" class="muted" data-test="search-empty">
    Nothing in your manuals matches “{{ searched }}”.
  </p>

  <div
    v-for="hit in results"
    :key="`${hit.manual_id}`"
    class="panel"
    :data-test="`hit-${hit.manual_id}`"
  >
    <div class="row" style="align-items: baseline">
      <h2 style="margin: 0">
        <RouterLink :to="`/modules/${hit.module_id}`">
          {{ hit.manufacturer }} {{ hit.module_name }}
        </RouterLink>
      </h2>
      <div class="shrink">
        <span class="badge" :class="hit.user_id === null ? 'found' : 'pending'">
          {{ hit.user_id === null ? 'shared manual' : hit.name }}
        </span>
      </div>
    </div>
    <p class="snippet" :data-test="`snippet-${hit.manual_id}`">
      <template v-for="(part, i) in splitSnippet(hit.snippet)" :key="i">
        <mark v-if="part.hit">{{ part.text }}</mark>
        <span v-else>{{ part.text }}</span>
      </template>
    </p>
    <p class="muted">
      <RouterLink :to="`/manuals/${hit.hash}`" :data-test="`read-${hit.manual_id}`">
        Read the text
      </RouterLink>
      &nbsp;·&nbsp;
      <a :href="`/api/manuals/${hit.hash}`" target="_blank" rel="noopener">Open the PDF</a>
      &nbsp;·&nbsp;
      <span v-if="hit.pages">{{ hit.pages }} page{{ hit.pages === 1 ? '' : 's' }}</span>
    </p>
  </div>

  <p v-if="hasMore">
    <button class="secondary" :disabled="searching" data-test="search-more" @click="run(offset + PAGE)">
      More results
    </button>
  </p>
</template>

<style scoped>
.snippet {
  overflow-wrap: anywhere;
}
mark {
  background: var(--accent-soft, rgba(255, 214, 102, 0.35));
  color: inherit;
  padding: 0 0.1em;
}
</style>
