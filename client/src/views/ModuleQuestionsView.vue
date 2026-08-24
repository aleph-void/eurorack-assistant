<script setup>
// What you have asked the assistant about this module, and where you ask the
// next one — the module IS the scope, so no scoping model reads a word of the
// wording at all; its components are offered beside the box so the asker can
// say which jack or knob they mean.
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
  <QuestionsPanel
    v-if="module"
    kind="module"
    :record-id="id"
    :components="module.components ?? []"
  />
</template>
