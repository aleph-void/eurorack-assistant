<script setup>
// What you have written down about this patch, and the captures filed under
// it by the scope.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import PatchNotesPanel from '../components/PatchNotesPanel.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <PatchNotesPanel v-if="patch" :patch-id="id" />
</template>
