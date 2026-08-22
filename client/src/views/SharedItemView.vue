<script setup>
// Reading something somebody shared with you. Deliberately its own page
// rather than the owner's: the patch and question pages are editors, and an
// editor whose every button fails is worse than a page that simply shows you
// what you were given.
//
// The endpoints are the ordinary ones — a shared record reads back exactly
// like your own, with `shared` set and the owner named.

import { computed, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';
import PatchDiagram from '../components/PatchDiagram.vue';

const props = defineProps({
  type: { type: String, required: true },
  id: { type: [String, Number], required: true },
});

const route = useRoute();
// Read-only, and a shared patch carries the same few thousand components a
// patch of your own does: held shallow for the same reason (PatchDetailView).
const item = shallowRef(null);
const error = ref('');
const loading = ref(true);

const PATHS = {
  note: (id) => `/api/notes/${id}`,
  patch: (id) => `/api/patches/${id}`,
  question: (id) => `/api/questions/${id}`,
  rack: (id) => `/api/racks/${id}`,
};

const TITLES = {
  note: 'Shared note',
  patch: 'Shared patch',
  question: 'Shared question',
  rack: 'Shared rack',
};

async function load() {
  loading.value = true;
  error.value = '';
  item.value = null;
  const path = PATHS[props.type];
  if (!path) {
    error.value = `There is nothing here to read: '${props.type}' is not something that gets shared.`;
    loading.value = false;
    return;
  }
  try {
    item.value = await api.get(path(props.id));
  } catch (e) {
    // The honest answer to a share that was withdrawn (or never made).
    error.value =
      e.status === 404
        ? 'This is not shared with you. The owner may have stopped sharing it, or deleted it.'
        : e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.type, props.id, route.fullPath], load, { immediate: true });

const heading = computed(() => TITLES[props.type] ?? 'Shared');

const answerHtml = computed(() =>
  item.value?.answer ? DOMPurify.sanitize(marked.parse(item.value.answer)) : ''
);

// The label under each panel in the diagram, the same one the owner sees.
const patchLabel = (pm) =>
  `${pm.manufacturer} ${pm.module_name}${pm.instance > 1 ? ` #${pm.instance}` : ''}` +
  (pm.label ? ` — ${pm.label}` : '');
</script>

<template>
  <h1>{{ heading }}</h1>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>

  <template v-else-if="item">
    <p class="muted" data-test="shared-by">
      <template v-if="item.shared">
        Shared with you by <strong>{{ item.owner_username }}</strong> — you can read it, and only
        they can change it.
      </template>
      <template v-else>This one is yours.</template>
    </p>

    <!-- A note: what it says, and what its owner attached it to. -->
    <div v-if="type === 'note'" class="panel" data-test="shared-note">
      <h2>{{ item.title || 'Untitled note' }}</h2>
      <p style="white-space: pre-wrap">{{ item.body }}</p>
      <p v-if="item.modules?.length || item.components?.length">
        <template v-for="m in item.modules" :key="`m${m.id}`">
          <span class="badge found">{{ m.manufacturer }} {{ m.name }}</span>
          &nbsp;
        </template>
        <template v-for="c in item.components" :key="`c${c.id}`">
          <span class="badge pending">
            {{ c.module_manufacturer }} {{ c.module_name }} · {{ c.name }}
          </span>
          &nbsp;
        </template>
      </p>
    </div>

    <!-- A question and the answer it got. -->
    <div v-else-if="type === 'question'" class="panel" data-test="shared-question">
      <h2>{{ item.prompt }}</h2>
      <p class="muted">
        <span class="badge" :class="item.status">{{ item.status }}</span>
        <template v-if="item.modules?.length">
          &nbsp;about {{ item.modules.map((m) => `${m.manufacturer} ${m.name}`).join(', ') }}
        </template>
      </p>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
      <div v-if="answerHtml" class="answer" data-test="shared-answer" v-html="answerHtml"></div>
      <p v-else class="muted" data-test="no-answer">This question has not been answered yet.</p>
    </div>

    <!-- A rack: what is in it. -->
    <div v-else-if="type === 'rack'" class="panel" data-test="shared-rack">
      <h2>{{ item.name }}</h2>
      <p class="muted">{{ item.module_count }} module(s)</p>
      <div v-if="item.modules?.length" class="table-wrap">
        <table data-test="shared-rack-modules">
          <thead>
            <tr>
              <th>Module</th>
              <th>HP</th>
              <th>Qty</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in item.modules" :key="m.id" :data-test="`shared-module-${m.id}`">
              <td data-label="Module">{{ m.manufacturer }} {{ m.name }}</td>
              <td data-label="HP">{{ m.hp ?? '—' }}</td>
              <td data-label="Qty">{{ m.quantity }}</td>
              <td data-label="What it does" class="muted">{{ m.summary || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">This rack is empty.</p>
    </div>

    <!-- A patch: the picture, then the cables and settings in words. -->
    <div v-else-if="type === 'patch'" data-test="shared-patch">
      <div class="panel">
        <h2>{{ item.name }}</h2>
        <p class="muted">From the rack '{{ item.rack_name }}'</p>
        <p v-if="item.description" style="white-space: pre-wrap">{{ item.description }}</p>
        <PatchDiagram
          :modules="item.modules || []"
          :cables="item.cables || []"
          :switches="item.switches || []"
          :label-for="patchLabel"
        />
      </div>

      <div class="panel">
        <h2>Cables</h2>
        <ul v-if="item.cables?.length" data-test="shared-cables">
          <li v-for="c in item.cables" :key="c.id">
            {{ c.from_component_name }} → {{ c.to_component_name }}
            <span v-if="c.note" class="muted">— {{ c.note }}</span>
            <span v-if="c.optional" class="badge pending">optional</span>
          </li>
        </ul>
        <p v-else class="muted">No cables in this patch.</p>

        <template v-if="item.settings?.length">
          <h2>Settings</h2>
          <ul data-test="shared-settings">
            <li v-for="s in item.settings" :key="s.id">
              {{ s.component_name }}: {{ s.value }}
            </li>
          </ul>
        </template>
      </div>
    </div>
  </template>
</template>

<style scoped>
.answer :deep(pre) {
  overflow-x: auto;
}
</style>
