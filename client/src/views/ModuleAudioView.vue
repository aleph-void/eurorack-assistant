<script setup>
// What this module sounds like: takes uploaded, recorded here, or asked of
// the oscilloscope at the bench.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import AudioRecordings from '../components/AudioRecordings.vue';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { module, error, rackModules, load } = useModuleRecord(toRef(props, 'id'));
</script>

<template>
  <ModuleDetailHeader
    :module="module"
    :module-id="id"
    :rack-modules="rackModules"
    :error="error"
    @reload="load"
  />
  <AudioRecordings v-if="module" kind="module" :record-id="id" />
</template>
