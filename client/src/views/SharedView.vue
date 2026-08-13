<script setup>
// The two directions of sharing on one page: what other people have handed to
// you, and what you have handed out. Everything here is somebody's private
// record that they chose to show — following a link reads it, and nothing on
// the far side can be changed.

import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import ShareButton from '../components/ShareButton.vue';

const incoming = ref(null);
const outgoing = ref(null);
const error = ref('');
const loading = ref(true);

// The five kinds, in the order the page shows them, with what to call each.
const KINDS = [
  { key: 'patches', type: 'patch', title: 'Patches' },
  { key: 'racks', type: 'rack', title: 'Racks' },
  { key: 'notes', type: 'note', title: 'Notes' },
  { key: 'questions', type: 'question', title: 'Questions & answers' },
  { key: 'documents', type: 'document', title: 'Documents' },
];

async function load() {
  loading.value = true;
  try {
    [incoming.value, outgoing.value] = await Promise.all([
      api.get('/api/shares/incoming'),
      api.get('/api/shares/outgoing'),
    ]);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const incomingCount = computed(() =>
  KINDS.reduce((sum, kind) => sum + (incoming.value?.[kind.key]?.length ?? 0), 0)
);
const outgoingCount = computed(() =>
  KINDS.reduce((sum, kind) => sum + (outgoing.value?.[kind.key]?.length ?? 0), 0)
);

// A document is read at its content hash; everything else has a page of its
// own under /shared.
const linkFor = (item) =>
  item.type === 'document' ? `/manuals/${item.hash}` : `/shared/${item.type}/${item.id}`;

// Who an outgoing share reaches, in words.
const audience = (item) => {
  const names = item.users.map((u) => u.username);
  if (item.everyone) {
    return names.length ? `everyone (and ${names.join(', ')} by name)` : 'everyone';
  }
  return names.join(', ');
};
</script>

<template>
  <h1>Shared</h1>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>

  <template v-else>
    <div class="panel">
      <h2>Shared with you</h2>
      <p v-if="incomingCount === 0" class="muted" data-test="no-incoming">
        Nobody has shared anything with you yet.
      </p>
      <template v-for="kind in KINDS" :key="`in-${kind.key}`">
        <template v-if="incoming[kind.key]?.length">
          <h3>{{ kind.title }}</h3>
          <ul class="share-items" :data-test="`incoming-${kind.key}`">
            <li v-for="item in incoming[kind.key]" :key="item.id">
              <RouterLink :to="linkFor(item)" :data-test="`incoming-${item.type}-${item.id}`">
                {{ item.label }}
              </RouterLink>
              <span class="muted"> — from {{ item.owner_username }}</span>
              <span v-if="item.rack_name" class="muted"> · {{ item.rack_name }}</span>
              <a
                v-if="item.type === 'document'"
                class="muted"
                :href="`/api/manuals/${item.hash}`"
                target="_blank"
                rel="noreferrer"
              >
                · PDF
              </a>
            </li>
          </ul>
        </template>
      </template>
    </div>

    <div class="panel">
      <h2>Shared by you</h2>
      <p class="muted">
        Anyone listed here can read what you shared. They cannot change or delete it, and clearing
        the list takes it back.
      </p>
      <p v-if="outgoingCount === 0" class="muted" data-test="no-outgoing">
        You have not shared anything yet. The Share button on a patch, rack, note, question or
        uploaded document is where that starts.
      </p>
      <template v-for="kind in KINDS" :key="`out-${kind.key}`">
        <template v-if="outgoing[kind.key]?.length">
          <h3>{{ kind.title }}</h3>
          <ul class="share-items" :data-test="`outgoing-${kind.key}`">
            <li v-for="item in outgoing[kind.key]" :key="item.id">
              <span>{{ item.label }}</span>
              <span class="muted"> — with {{ audience(item) }}</span>
              <ShareButton
                :type="item.type"
                :id="item.id"
                :label="item.label"
                small
                @changed="load"
              />
            </li>
          </ul>
        </template>
      </template>
    </div>
  </template>
</template>

<style scoped>
.share-items {
  list-style: none;
  padding: 0;
  margin: 0 0 0.8rem;
}
.share-items li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}
h3 {
  margin-bottom: 0.2rem;
}
</style>
