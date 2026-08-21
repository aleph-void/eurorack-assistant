<script setup>
// Every cable in the patch, written out — and the form that plugs the next
// one, by picker or by one typed line.
import { onMounted, ref, toRef } from 'vue';
import { api } from '../api.js';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import CablesSection from '../components/patchdetail/CablesSection.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));

// Cables worth plugging next, learned from the user's other patches.
const suggestions = ref([]);

async function loadSuggestions() {
  try {
    const res = await api.get(`/api/patches/${props.id}/suggestions`, { quiet: true });
    suggestions.value = res?.suggestions ?? [];
  } catch {
    suggestions.value = [];
  }
}
onMounted(loadSuggestions);

async function reload() {
  await load();
  await loadSuggestions();
}
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <CablesSection
    v-if="patch"
    :patch="patch"
    :patch-id="id"
    :suggestions="suggestions"
    @reload="reload"
  />
</template>
