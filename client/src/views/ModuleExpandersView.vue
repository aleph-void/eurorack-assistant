<script setup>
// The panels this module hosts over a ribbon cable.
import { computed, toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import ExpandersSection from '../components/moduledetail/ExpandersSection.vue';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { module, error, rackModules, load } = useModuleRecord(toRef(props, 'id'));

// Candidates for an expander link: the other modules in your racks.
const candidates = computed(() =>
  rackModules.value.filter(
    (m) =>
      m.id !== Number(props.id) &&
      !(module.value?.expanders || []).some((e) => e.module_id === m.id)
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
  <ExpandersSection
    v-if="module"
    :module="module"
    :module-id="id"
    :candidates="candidates"
    @reload="load"
  />
</template>
