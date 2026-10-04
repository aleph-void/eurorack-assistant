<script setup>
// Everybody's performances: videos of people playing their systems, newest
// first, and the form that shares one of yours. The one list in the app
// that is not "yours" — a performance is published to every account the
// moment it is shared, which is the point of sharing it.
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import PerformanceForm from '../components/performances/PerformanceForm.vue';

const router = useRouter();
const PAGE = 50;
const performances = ref([]);
const total = ref(0);
const hasMore = ref(false);
const nextBefore = ref(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const sharing = ref(false);
const formOpen = ref(false);

function applyPage(page, { append = false } = {}) {
  const rows = page?.performances ?? [];
  performances.value = append ? performances.value.concat(rows) : rows;
  total.value = page?.total ?? performances.value.length;
  hasMore.value = Boolean(page?.has_more);
  nextBefore.value = page?.next_before ?? null;
}

async function load() {
  try {
    applyPage(await api.get(`/api/performances?limit=${PAGE}`));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    applyPage(await api.get(`/api/performances?limit=${PAGE}&before=${nextBefore.value}`), {
      append: true,
    });
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMore.value = false;
  }
}

// A shared performance opens on its own page: that is where it is watched.
async function share(payload) {
  error.value = '';
  sharing.value = true;
  try {
    const created = await api.post('/api/performances', payload);
    router.push(`/performances/${created.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    sharing.value = false;
  }
}

const when = (value) => (value ? new Date(value).toLocaleDateString() : '');

onMounted(load);
</script>

<template>
  <h1>Performances</h1>
  <p class="muted">
    Videos of people playing their systems. Share a link to a performance you recorded and everyone
    here can watch it, see which modules you used and the patch if you choose to show it, and
    leave a comment.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="performances.length" class="table-wrap">
      <table data-test="performance-table">
        <thead>
          <tr>
            <th>Performance</th>
            <th>By</th>
            <th>Modules</th>
            <th>Comments</th>
            <th>Shared</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in performances" :key="p.id" :data-test="`performance-${p.id}`">
            <td data-label="Performance">
              <RouterLink :to="`/performances/${p.id}`">{{ p.title }}</RouterLink>
              <span v-if="p.patch?.live" class="badge found">patch shown</span>
              <span v-if="p.public" class="badge pending" data-test="public-badge">public</span>
              <span v-if="p.mine" class="badge" data-test="mine-badge">yours</span>
            </td>
            <td data-label="By">{{ p.owner_username }}</td>
            <td data-label="Modules">{{ p.module_count }}</td>
            <td data-label="Comments">{{ p.comment_count }}</td>
            <td data-label="Shared" class="muted">{{ when(p.created_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted" data-test="no-performances">
      Nobody has shared a performance yet. Yours could be the first.
    </p>
    <p v-if="performances.length" class="muted" data-test="performance-count">
      Showing {{ performances.length }} of {{ total }}
      <button
        v-if="hasMore"
        type="button"
        class="secondary"
        :disabled="loadingMore"
        data-test="load-more"
        @click="loadMore"
      >
        Show more
      </button>
    </p>
  </div>

  <div class="panel">
    <h2>Share a performance</h2>
    <p class="muted">
      Paste the link to a video of yours on YouTube. The video stays on YouTube; this page embeds
      it, and nothing is downloaded.
    </p>
    <button v-if="!formOpen" type="button" data-test="open-share" @click="formOpen = true">
      Share a video
    </button>
    <PerformanceForm v-else submit-label="Share" :busy="sharing" @submit="share" />
  </div>
</template>
