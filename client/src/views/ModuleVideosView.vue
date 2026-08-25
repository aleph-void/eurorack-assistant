<script setup>
// The videos attached to this module: YouTube links with their analysis, and
// the clips recorded from the linked oscilloscope.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import VideosSection from '../components/moduledetail/VideosSection.vue';
import ClipsSection from '../components/moduledetail/ClipsSection.vue';
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
  <VideosSection v-if="module" :module="module" :module-id="id" @reload="load" />
  <ClipsSection v-if="module" :module="module" :module-id="id" @reload="load" />
</template>
