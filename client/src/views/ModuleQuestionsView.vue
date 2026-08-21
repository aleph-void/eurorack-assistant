<script setup>
// What you have asked the assistant about this module, and where you ask the
// next one — the module is in scope before the scoping model reads a word.
import { toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import QuestionsPanel from '../components/QuestionsPanel.vue';
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
  <QuestionsPanel v-if="module" kind="module" :record-id="id" />
</template>
