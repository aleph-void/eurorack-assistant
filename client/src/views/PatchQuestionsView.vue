<script setup>
// What you have asked the assistant about this patch, and where you ask the
// next one — asking here attaches the patch itself, so the cables, the
// control settings and the signal flow go to the model with the question.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import QuestionsPanel from '../components/QuestionsPanel.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <QuestionsPanel v-if="patch" kind="patch" :record-id="id" />
</template>
