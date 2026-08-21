<script setup>
// The settings this module keeps in a menu rather than under a control.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import ParametersSection from '../components/moduledetail/ParametersSection.vue';
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
  <ParametersSection v-if="module" :module="module" :module-id="id" @reload="load" />
</template>
