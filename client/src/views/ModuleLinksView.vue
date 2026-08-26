<script setup>
// The rest of this module's story: the forum thread, the maker's page, the
// video of the patch you are rebuilding.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import ResourceLinks from '../components/ResourceLinks.vue';
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
  <ResourceLinks v-if="module" kind="module" :record-id="id" />
</template>
