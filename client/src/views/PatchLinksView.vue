<script setup>
// The instances that move together, the buses they play in, and the gear the
// rack does not hold.
import { onMounted, ref, toRef } from 'vue';
import { api } from '../api.js';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import LinksSection from '../components/patchdetail/LinksSection.vue';
import GroupsSection from '../components/patchdetail/GroupsSection.vue';
import ExtrasSection from '../components/patchdetail/ExtrasSection.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));

// The modules of the rack, offered when declaring gear the patch invented.
const rackModules = ref([]);
onMounted(async () => {
  try {
    const list = await api.get('/api/modules', { quiet: true });
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
});
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <template v-if="patch">
    <LinksSection :patch="patch" :patch-id="id" @reload="load" />
    <GroupsSection :patch="patch" :patch-id="id" @reload="load" />
    <ExtrasSection :patch="patch" :patch-id="id" :rack-modules="rackModules" @reload="load" />
  </template>
</template>
