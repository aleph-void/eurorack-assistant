<script setup>
// One composition mapped onto one patch: which module, control, bus or cable
// plays each part here, the notes on this way of playing it, and the
// performance sheet the two make together.
//
// Three reads: the composition (for its storyboard), the mapping (the
// bindings, each marked live or not), and the patch payload (what the
// pickers offer). The patch is the big one and is read once; the other two
// are re-read after every write.
import { computed, onMounted, ref, shallowRef, toRef, watch } from 'vue';
import { api } from '../api.js';
import CompositionHeader from '../components/compositions/CompositionHeader.vue';
import MappingTable from '../components/compositions/MappingTable.vue';
import PerformanceSheet from '../components/compositions/PerformanceSheet.vue';
import { useCompositionRecord } from '../components/compositions/useCompositionRecord.js';

const props = defineProps({
  id: { type: String, required: true },
  patchId: { type: String, required: true },
});

const { composition, error, load: loadComposition } = useCompositionRecord(toRef(props, 'id'));
const realization = shallowRef(null);
const patch = shallowRef(null);
const mappingError = ref('');
const notes = ref('');
const notesSaved = ref(false);

async function loadRealization() {
  mappingError.value = '';
  try {
    realization.value = await api.get(`/api/compositions/${props.id}/patches/${props.patchId}`);
    notes.value = realization.value.notes ?? '';
  } catch (e) {
    mappingError.value = e.message;
  }
}

async function loadPatch() {
  try {
    patch.value = await api.get(`/api/patches/${props.patchId}`);
  } catch (e) {
    mappingError.value = e.message;
  }
}

async function reload() {
  await Promise.all([loadComposition(), loadRealization()]);
}

onMounted(() => Promise.all([loadRealization(), loadPatch()]));
watch(() => props.patchId, () => Promise.all([loadRealization(), loadPatch()]));

async function saveNotes() {
  mappingError.value = '';
  notesSaved.value = false;
  try {
    await api.put(`/api/compositions/${props.id}/patches/${props.patchId}`, { notes: notes.value });
    notesSaved.value = true;
    await loadRealization();
  } catch (e) {
    mappingError.value = e.message;
  }
}

const heading = computed(() =>
  realization.value ? `On '${realization.value.patch_name}'` : ''
);
</script>

<template>
  <CompositionHeader
    :composition="composition"
    :composition-id="id"
    :error="error"
    :sub="heading"
    @reload="reload"
  />
  <p v-if="mappingError" class="error" data-test="mapping-page-error">{{ mappingError }}</p>
  <template v-if="composition && realization">
    <p class="muted">
      <RouterLink :to="`/patches/${patchId}`" data-test="open-patch">Open the patch</RouterLink>
      · {{ realization.system_name || realization.rack_name }}
    </p>
    <MappingTable
      :realization="realization"
      :patch="patch"
      :composition-id="id"
      :patch-id="patchId"
      @reload="reload"
    />
    <div class="panel">
      <h2>Notes on this way of playing it</h2>
      <form data-test="notes-form" @submit.prevent="saveNotes">
        <textarea
          v-model="notes"
          rows="3"
          placeholder="What is particular to performing it on this patch"
          data-test="notes-input"
          aria-label="Notes"
        ></textarea>
        <div class="actions">
          <button type="submit" data-test="notes-save">Save notes</button>
          <span v-if="notesSaved" class="muted">Saved.</span>
        </div>
      </form>
    </div>
    <PerformanceSheet :composition="composition" :mappings="realization.mappings" />
  </template>
</template>
