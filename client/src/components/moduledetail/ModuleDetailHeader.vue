<script setup>
// The top of every module page: which module this is, how far its research
// got, and the corrections that are about the module itself rather than any
// one section. It is drawn by all twelve module routes, so it is also what
// tells the nav drawer which module's sub-pages to offer.
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../../api.js';
import { useDetailStore } from '../../stores/detail.js';

const props = defineProps({
  module: { type: Object, default: null },
  moduleId: { type: String, required: true },
  rackModules: { type: Array, default: () => [] },
  error: { type: String, default: '' },
});
const emit = defineEmits(['reload']);

const route = useRoute();
const detail = useDetailStore();

// How many rows each of the module's pages has, keyed by the page keys the
// nav drawer uses, so it can badge the full pages and fold the empty ones
// away. Pages whose rows are not in this payload (recordings, links,
// questions) are left out: absent means unknown, not empty. The scope page
// is left out on purpose — it is a bench to take captures at, not a list.
function moduleCounts(m) {
  if (!m) return {};
  const components = m.components || [];
  const ofType = (type) => components.filter((c) => c.type === type).length;
  const counts = { components: components.length };
  // Of the ten component types, only the three kinds of jack are drawer
  // entries; the rest are reached through the chip row on the component
  // pages, which counts them off the payload itself.
  counts.input_jack = ofType('input_jack');
  counts.output_jack = ofType('output_jack');
  counts.bidirectional_jack = ofType('bidirectional_jack');
  counts.values = components.reduce((n, c) => n + (c.values?.length || 0), 0);
  counts.parameters = (m.parameters || []).length;
  counts.normalizations = (m.normalizations || []).length;
  counts.routing_switches = (m.switches || []).length;
  counts.routes = (m.routes || []).length;
  counts.pairs = (m.pairs || []).length;
  // A suggested-but-unlinked expander is still something the page shows.
  counts.expanders = (m.expanders || []).length + (m.expander_suggestions || []).length;
  counts.bridges = (m.bridges || []).length;
  counts.documents = (m.manuals || []).length;
  // Bench clips appear on the videos page beside the imported videos.
  counts.videos = (m.videos || []).length + (m.clips || []).length;
  counts.notes = (m.notes || []).length;
  return counts;
}

// The drawer says the module by name while any of its pages is open. The
// payload rides in the watch because a reload replaces it wholesale, and the
// counts have to follow the row that was just added or removed.
let claim = 0;
watch(
  () => [props.moduleId, props.module],
  () => {
    const label = props.module ? `${props.module.manufacturer} ${props.module.name}` : '';
    claim = detail.set('module', props.moduleId, label, moduleCounts(props.module));
  },
  { immediate: true }
);
onUnmounted(() => detail.clear(claim));

// --- Naming/HP correction (shared record: a fix shows for every user).
// Saved with a plain PATCH — no re-analysis is triggered. ---
const editingNaming = ref(false);
const editManufacturer = ref('');
const editModuleName = ref('');
const editHp = ref('');
const savingNaming = ref(false);
const namingError = ref('');

function startEditNaming() {
  editManufacturer.value = props.module.manufacturer;
  editModuleName.value = props.module.name;
  editHp.value = props.module.hp == null ? '' : String(props.module.hp);
  namingError.value = '';
  editingNaming.value = true;
}

async function saveNaming() {
  const manufacturer = editManufacturer.value.trim();
  const name = editModuleName.value.trim();
  const hp = editHp.value.trim();
  if (!manufacturer || !name) {
    namingError.value = 'Manufacturer and name are both required';
    return;
  }
  savingNaming.value = true;
  namingError.value = '';
  try {
    await api.patch(`/api/modules/${props.moduleId}`, { manufacturer, name, hp: hp || null });
    editingNaming.value = false;
    emit('reload');
  } catch (e) {
    namingError.value = e.message;
  } finally {
    savingNaming.value = false;
  }
}

// --- Rack quantity correction (how many copies each rack contains) ---
const editingQuantities = ref(false);
const editQuantities = ref({});
const savingQuantities = ref(false);
const quantityError = ref('');

function startEditQuantities() {
  editQuantities.value = Object.fromEntries(
    props.module.racks.map((r) => [r.id, String(r.quantity)])
  );
  quantityError.value = '';
  editingQuantities.value = true;
}

async function saveQuantities() {
  const changes = [];
  for (const rack of props.module.racks) {
    const quantity = Number(String(editQuantities.value[rack.id] ?? '').trim());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      quantityError.value = `Quantity in ${rack.name} must be a whole number between 1 and 99`;
      return;
    }
    if (quantity !== rack.quantity) changes.push({ rack, quantity });
  }
  savingQuantities.value = true;
  quantityError.value = '';
  try {
    for (const { rack, quantity } of changes) {
      await api.put(`/api/racks/${rack.id}/modules/${props.moduleId}`, { quantity });
    }
    editingQuantities.value = false;
    emit('reload');
  } catch (e) {
    quantityError.value = e.message;
  } finally {
    savingQuantities.value = false;
  }
}

// Keep detail-page navigation in the rack the user came from. A direct visit
// has no rack in its URL, so use the module's first rack as a stable default.
const navigationRackId = computed(() => {
  const requested = Number(route.query.rack);
  if (requested && props.module?.racks?.some((rack) => rack.id === requested)) return requested;
  return props.module?.racks?.[0]?.id ?? null;
});
const modulesInNavigationRack = computed(() => {
  if (!navigationRackId.value) return [];
  return props.rackModules.filter((candidate) =>
    candidate.racks?.some((rack) => rack.id === navigationRackId.value)
  );
});
// Previous/next stay on the page the user is reading: the components of one
// module then the components of the next, rather than back to the top each
// time. The path after /modules/:id is whatever this route added to it.
const subPath = computed(() => {
  const match = /^\/modules\/[^/]+(\/.*)?$/.exec(route.path || '');
  return match?.[1] || '';
});
const siblingHref = (moduleId) => {
  const query = navigationRackId.value ? `?rack=${navigationRackId.value}` : '';
  return `/modules/${moduleId}${subPath.value}${query}`;
};
const indexInRack = computed(() =>
  modulesInNavigationRack.value.findIndex((candidate) => candidate.id === Number(props.moduleId))
);
const nextModule = computed(() =>
  indexInRack.value < 0 ? null : modulesInNavigationRack.value[indexInRack.value + 1] ?? null
);
const previousModule = computed(() =>
  indexInRack.value <= 0 ? null : modulesInNavigationRack.value[indexInRack.value - 1] ?? null
);
const modulesHref = computed(() =>
  navigationRackId.value ? `/modules?rack=${navigationRackId.value}` : '/modules'
);
const previousModuleHref = computed(() =>
  previousModule.value ? siblingHref(previousModule.value.id) : null
);
const nextModuleHref = computed(() =>
  nextModule.value ? siblingHref(nextModule.value.id) : null
);
</script>

<template>
  <nav class="module-detail-navigation" aria-label="Module navigation">
    <span>
      <RouterLink v-if="previousModule" :to="previousModuleHref" data-test="previous-module">
        ← Previous Module
      </RouterLink>
    </span>
    <RouterLink :to="modulesHref">← All modules</RouterLink>
    <span>
      <RouterLink v-if="nextModule" :to="nextModuleHref" data-test="next-module">
        Next Module →
      </RouterLink>
    </span>
  </nav>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="module">
    <div v-if="editingNaming" class="row reanalyze-row" data-test="edit-naming">
      <input
        v-model="editManufacturer"
        aria-label="Manufacturer"
        placeholder="Manufacturer"
        style="flex: 0 0 auto; width: 13rem"
        data-test="edit-manufacturer"
      />
      <input
        v-model="editModuleName"
        aria-label="Module name"
        placeholder="Module name"
        style="flex: 0 0 auto; width: 13rem"
        data-test="edit-module-name"
      />
      <input
        v-model="editHp"
        aria-label="Width in HP"
        placeholder="HP"
        style="flex: 0 0 auto; width: 4.5rem"
        title="Width in HP — leave empty if unknown"
        data-test="edit-hp"
      />
      <button style="margin: 0" :disabled="savingNaming" data-test="save-naming" @click="saveNaming">
        {{ savingNaming ? 'Saving…' : 'Save' }}
      </button>
      <button
        style="margin: 0"
        class="secondary"
        data-test="cancel-naming"
        @click="editingNaming = false"
      >
        Cancel
      </button>
    </div>
    <h1 v-else>
      {{ module.manufacturer }} {{ module.name }}
      <button
        class="linklike"
        style="font-size: 1rem; vertical-align: middle"
        title="Correct the manufacturer, module name or HP without re-analysis (the fix shows for every user of this module)"
        data-test="edit-naming-button"
        @click="startEditNaming"
      >
        Edit
      </button>
      <RouterLink
        :to="`/modules/${moduleId}/questions`"
        style="font-size: 0.8rem"
        data-test="ask-about-module"
      >
        Ask about this module
      </RouterLink>
    </h1>
    <p v-if="namingError" class="error" data-test="naming-error">{{ namingError }}</p>
    <p>
      <span class="badge" :class="module.manual_status">manual: {{ module.manual_status }}</span>
      &nbsp;
      <span class="badge" :class="module.analysis_status">
        analysis: {{ module.analysis_status }}
      </span>
      &nbsp;
      <span class="badge" :class="module.panel_status">panel: {{ module.panel_status }}</span>
      <template v-if="module.hp">
        &nbsp;
        <span class="badge" data-test="module-hp">{{ module.hp }}HP</span>
      </template>
    </p>
    <div v-if="editingQuantities" class="row reanalyze-row" data-test="edit-quantities">
      <label v-for="r in module.racks" :key="r.id" style="flex: 0 0 auto">
        {{ r.name }} ×
        <input
          v-model="editQuantities[r.id]"
          :aria-label="`Quantity in ${r.name}`"
          style="width: 4rem"
          :data-test="`edit-quantity-${r.id}`"
        />
      </label>
      <button
        style="margin: 0"
        :disabled="savingQuantities"
        data-test="save-quantities"
        @click="saveQuantities"
      >
        {{ savingQuantities ? 'Saving…' : 'Save' }}
      </button>
      <button
        style="margin: 0"
        class="secondary"
        data-test="cancel-quantities"
        @click="editingQuantities = false"
      >
        Cancel
      </button>
    </div>
    <p v-else-if="module.racks?.length" data-test="racks">
      In {{ module.racks.length === 1 ? 'rack' : 'racks' }}:
      {{ module.racks.map((r) => `${r.name} (×${r.quantity})`).join(', ') }}
      <button
        class="linklike"
        title="Change how many copies of this module each rack contains"
        data-test="edit-quantities-button"
        @click="startEditQuantities"
      >
        Edit
      </button>
      — <RouterLink to="/racks">manage racks</RouterLink>
    </p>
    <p v-if="quantityError" class="error" data-test="quantity-error">{{ quantityError }}</p>
  </template>
</template>
