<script setup>
// A manual, read as a page rather than opened as a PDF. The server stores the
// markdown it extracted from the document (server/src/services/manualText.js);
// this renders it with marked and sanitizes the result before it goes into the
// DOM — the text comes out of a PDF somebody else wrote, so it is never
// trusted as markup.
import { computed, onMounted, ref, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';

const props = defineProps({ hash: { type: String, required: true } });

const document = ref(null);
const error = ref('');
const loading = ref(true);
// Rendered by default; the markdown source is a click away.
const showSource = ref(false);

const rendered = computed(() =>
  document.value?.content ? DOMPurify.sanitize(marked.parse(document.value.content)) : ''
);

async function load() {
  loading.value = true;
  error.value = '';
  document.value = null;
  try {
    document.value = await api.get(`/api/manuals/${props.hash}/text`);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.hash, load);
onMounted(load);
</script>

<template>
  <p v-if="document">
    <RouterLink :to="`/modules/${document.module_id}`">
      ← {{ document.manufacturer }} {{ document.module_name }}
    </RouterLink>
  </p>
  <p v-else><RouterLink to="/search">← Search manuals</RouterLink></p>

  <p v-if="loading" class="muted" data-test="manual-loading">Loading the manual…</p>
  <p v-if="error" class="error" data-test="manual-error">{{ error }}</p>

  <template v-if="document">
    <h1>{{ document.title || 'Manual' }}</h1>
    <p class="muted">
      <span v-if="document.pages">{{ document.pages }} page{{ document.pages === 1 ? '' : 's' }}</span>
      <template v-if="document.pages">&nbsp;·&nbsp;</template>
      <span>
        {{ document.user_id === null ? 'the shared manual' : 'your document' }}, read out of the PDF
      </span>
    </p>
    <p>
      <a :href="`/api/manuals/${hash}`" target="_blank" rel="noopener" data-test="open-pdf">
        Open the PDF
      </a>
      &nbsp;·&nbsp;
      <a :href="`/api/manuals/${hash}/text/export`" data-test="download-markdown">
        Download the markdown
      </a>
      &nbsp;·&nbsp;
      <a href="#" data-test="toggle-source" @click.prevent="showSource = !showSource">
        {{ showSource ? 'Show it rendered' : 'Show the markdown source' }}
      </a>
    </p>

    <div class="panel">
      <pre v-if="showSource" class="manual-source" data-test="manual-source">{{
        document.content
      }}</pre>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized above -->
      <article v-else class="answer manual-body" data-test="manual-body" v-html="rendered"></article>
    </div>
  </template>
</template>

<style scoped>
.manual-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  margin: 0;
}
/* A manual is a long read: keep the measure sane and the headings apart. */
.manual-body {
  max-width: 70ch;
}
.manual-body :deep(h1),
.manual-body :deep(h2),
.manual-body :deep(h3),
.manual-body :deep(h4) {
  margin-top: 1.6em;
}
.manual-body :deep(pre) {
  white-space: pre;
  overflow-x: auto;
}
</style>
