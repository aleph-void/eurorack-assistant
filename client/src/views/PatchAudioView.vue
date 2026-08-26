<script setup>
// What this patch sounds like: takes uploaded, recorded here, or asked of the
// oscilloscope's audio interface while the patch is up.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import AudioRecordings from '../components/AudioRecordings.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <AudioRecordings v-if="patch" kind="patch" :record-id="id" />
</template>
