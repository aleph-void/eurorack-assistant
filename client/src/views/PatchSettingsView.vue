<script setup>
// What each control is dialled to in this patch.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import SettingsSection from '../components/patchdetail/SettingsSection.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <SettingsSection v-if="patch" :patch="patch" :patch-id="id" @reload="load" />
</template>
