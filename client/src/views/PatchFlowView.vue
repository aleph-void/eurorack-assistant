<script setup>
// Where signal goes once it leaves a jack: the traced flow, and the
// connections the modules make for themselves when nothing is plugged in.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import FlowSection from '../components/patchdetail/FlowSection.vue';
import NormalledSection from '../components/patchdetail/NormalledSection.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <template v-if="patch">
    <FlowSection :patch="patch" />
    <NormalledSection :patch="patch" />
  </template>
</template>
