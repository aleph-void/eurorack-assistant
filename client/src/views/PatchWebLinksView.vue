<script setup>
// The links kept beside this patch: the track it ended up on, the video it
// came from, the thread that explained the trick.
//
// Not to be confused with the patch's MODULE links — the ribbon and bridge
// cables that join two panels — which are on the Gear page.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import ResourceLinks from '../components/ResourceLinks.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <ResourceLinks v-if="patch" kind="patch" :record-id="id" />
</template>
