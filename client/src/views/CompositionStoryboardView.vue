<script setup>
// A composition's storyboard: the grid of scenes and parts, and the patches
// it is mapped onto.
import { toRef } from 'vue';
import CompositionHeader from '../components/compositions/CompositionHeader.vue';
import StoryboardGrid from '../components/compositions/StoryboardGrid.vue';
import MappedPatches from '../components/compositions/MappedPatches.vue';
import { useCompositionRecord } from '../components/compositions/useCompositionRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { composition, error, load } = useCompositionRecord(toRef(props, 'id'));
</script>

<template>
  <CompositionHeader :composition="composition" :composition-id="id" :error="error" @reload="load" />
  <template v-if="composition">
    <StoryboardGrid :composition="composition" :composition-id="id" @reload="load" />
    <MappedPatches :composition="composition" :composition-id="id" @reload="load" />
  </template>
</template>
