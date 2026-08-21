<script setup>
// The other half of a dual: two panels of one product joined by a link cable rather than by patch cables.
import { computed, toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import BridgesSection from '../components/moduledetail/BridgesSection.vue';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { module, error, rackModules, load } = useModuleRecord(toRef(props, 'id'));

// The other half of a dual may be a separate module record — or this same
// record racked twice, which the section offers on its own.
const candidates = computed(() =>
  rackModules.value.filter(
    (m) =>
      m.id !== Number(props.id) &&
      !(module.value?.bridges || []).some((b) => b.module_id === m.id)
  )
);
</script>

<template>
  <ModuleDetailHeader
    :module="module"
    :module-id="id"
    :rack-modules="rackModules"
    :error="error"
    @reload="load"
  />
  <BridgesSection
    v-if="module"
    :module="module"
    :module-id="id"
    :candidates="candidates"
    @reload="load"
  />
</template>
