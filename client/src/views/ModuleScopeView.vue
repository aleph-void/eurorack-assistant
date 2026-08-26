<script setup>
// The oscilloscope side of one module: capturing a still of what its jacks
// are doing at the bench, and recording a few seconds of it.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import ModuleScopeSection from '../components/moduledetail/ModuleScopeSection.vue';
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
  <ModuleScopeSection v-if="module" :module="module" :module-id="id" @reload="load" />
  <ClipsSection v-if="module" :module="module" :module-id="id" @reload="load" />
</template>
