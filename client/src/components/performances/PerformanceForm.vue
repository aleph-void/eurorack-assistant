<script setup>
// What a performance SAYS, as its author fills it in: the video, a title, a
// few words, which of their patches to show beside it, and which modules
// were used. One form for sharing a new one and for changing one later, so
// the two never drift apart in what they ask or how they ask it.
//
// The patch and module lists are the author's own (GET /api/patches, GET
// /api/modules) — a performance names what you played, not what somebody
// else owns — and are read when the form appears, not when the page does: a
// list of performances should not open with every patch of yours in tow.
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api.js';

const props = defineProps({
  // The performance being edited, or null for a new one.
  initial: { type: Object, default: null },
  submitLabel: { type: String, default: 'Share' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['submit', 'cancel']);

const url = ref(props.initial?.url ?? '');
const title = ref(props.initial?.title ?? '');
const description = ref(props.initial?.description ?? '');
const isPublic = ref(Boolean(props.initial?.public));
const patchId = ref(props.initial?.patch?.live ? String(props.initial.patch.id) : '');
const chosen = ref(new Set((props.initial?.modules ?? []).map((m) => m.id)));

const patches = ref([]);
const modules = ref([]);
const loading = ref(true);
const filter = ref('');

onMounted(async () => {
  try {
    const [patchPage, moduleList] = await Promise.all([
      api.get('/api/patches?limit=500', { quiet: true }),
      api.get('/api/modules', { quiet: true }),
    ]);
    patches.value = patchPage?.patches ?? [];
    modules.value = moduleList ?? [];
  } catch {
    // The pickers are then empty; the video and the words still go through.
  } finally {
    loading.value = false;
  }
});

const moduleLabel = (m) => `${m.manufacturer} ${m.name}`;

// Ticked modules first, then the rest, narrowed by what is typed — a rack
// of eighty modules is a list you search, not one you read.
const shownModules = computed(() => {
  const terms = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (m) =>
    terms.length === 0 || terms.every((t) => moduleLabel(m).toLowerCase().includes(t));
  const ticked = modules.value.filter((m) => chosen.value.has(m.id));
  const rest = modules.value.filter((m) => !chosen.value.has(m.id) && matches(m));
  return [...ticked, ...rest];
});

function toggle(id) {
  const next = new Set(chosen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosen.value = next;
}

// The one shape both routes take. The patch is null, not absent, when the
// author picks "none": on an edit that is what withdraws it — which is why
// the button waits for the pickers to load, or a quick Save on an edit would
// withdraw a patch the select had not yet been able to show.
function submit() {
  emit('submit', {
    url: url.value.trim(),
    title: title.value.trim(),
    description: description.value.trim() || null,
    public: isPublic.value,
    patch_id: patchId.value ? Number(patchId.value) : null,
    module_ids: modules.value.filter((m) => chosen.value.has(m.id)).map((m) => m.id),
  });
}
</script>

<template>
  <form data-test="performance-form" @submit.prevent="submit">
    <div class="row">
      <label :for="`performance-url-${initial?.id ?? 'new'}`">YouTube link</label>
      <input
        :id="`performance-url-${initial?.id ?? 'new'}`"
        v-model="url"
        required
        placeholder="https://www.youtube.com/watch?v=…"
        data-test="performance-url"
      />
    </div>
    <div class="row">
      <label :for="`performance-title-${initial?.id ?? 'new'}`">Title</label>
      <input
        :id="`performance-title-${initial?.id ?? 'new'}`"
        v-model="title"
        required
        maxlength="200"
        data-test="performance-title"
      />
    </div>
    <div class="row">
      <label :for="`performance-description-${initial?.id ?? 'new'}`">About it</label>
      <textarea
        :id="`performance-description-${initial?.id ?? 'new'}`"
        v-model="description"
        rows="3"
        maxlength="5000"
        placeholder="Optional — what you played, how the patch works, what to listen for"
        data-test="performance-description"
      ></textarea>
    </div>
    <label class="public-check" data-test="performance-public-label">
      <input v-model="isPublic" type="checkbox" data-test="performance-public" />
      Anyone with the link can watch — no account needed. Comments still take one.
    </label>
    <div class="row">
      <label :for="`performance-patch-${initial?.id ?? 'new'}`">Show a patch</label>
      <select
        :id="`performance-patch-${initial?.id ?? 'new'}`"
        v-model="patchId"
        :disabled="loading"
        data-test="performance-patch"
      >
        <option value="">None — keep the patch to yourself</option>
        <option v-for="p in patches" :key="p.id" :value="String(p.id)">
          {{ p.name }}<template v-if="p.rack_name"> ({{ p.rack_name }})</template>
        </option>
      </select>
    </div>
    <p class="muted">
      A patch you show here can be read by everyone who sees the performance, cables and settings
      included, without being shared any other way. Clearing it takes that back.
    </p>

    <div class="row">
      <label :for="`performance-filter-${initial?.id ?? 'new'}`">
        Modules used
        <span v-if="chosen.size" class="badge" data-test="module-count">{{ chosen.size }}</span>
      </label>
      <input
        :id="`performance-filter-${initial?.id ?? 'new'}`"
        v-model="filter"
        placeholder="Type to find a module…"
        data-test="module-filter"
      />
    </div>
    <p v-if="loading" class="muted">Loading your modules…</p>
    <p v-else-if="modules.length === 0" class="muted" data-test="no-modules">
      You have no modules racked yet, so there is nothing to list.
    </p>
    <ul v-else class="check-list module-list" data-test="module-list">
      <li v-for="m in shownModules" :key="m.id">
        <label>
          <input
            type="checkbox"
            :checked="chosen.has(m.id)"
            :data-test="`module-${m.id}`"
            @change="toggle(m.id)"
          />
          {{ moduleLabel(m) }}
        </label>
      </li>
    </ul>

    <div class="actions">
      <button type="submit" :disabled="busy || loading || !url.trim() || !title.trim()" data-test="performance-submit">
        {{ submitLabel }}
      </button>
      <button
        v-if="initial"
        type="button"
        class="secondary"
        data-test="performance-cancel"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </div>
  </form>
</template>

<style scoped>
.public-check {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0.6rem 0;
  color: var(--text);
}
.public-check input {
  width: auto;
  margin: 0;
}
.module-list {
  max-height: 16rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.3rem 0.6rem;
}
</style>
