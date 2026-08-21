<script setup>
// What the marker colours mean. Every picture of a panel draws a component in
// the colour of its type (componentTypes.js), which is only readable with the
// key beside it — so the key sits under each picture, listing the types that
// are actually on this one rather than the whole catalogue.

import { computed } from 'vue';
import { componentColor, typeLabel, typesPresent } from '../componentTypes.js';

const props = defineProps({
  // Components or panel placements — anything carrying a `type`.
  items: { type: Array, default: () => [] },
});

const entries = computed(() =>
  typesPresent(props.items).map((type) => ({ type, color: componentColor(type) }))
);
</script>

<template>
  <p v-if="entries.length" class="component-legend" data-test="component-legend">
    <span v-for="entry in entries" :key="entry.type" :data-test="`legend-${entry.type}`">
      <span class="legend-dot" :style="{ background: entry.color }" aria-hidden="true"></span>
      {{ typeLabel(entry.type) }}
    </span>
  </p>
</template>

<style scoped>
.component-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.9rem;
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  color: var(--muted);
}
.component-legend > span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.legend-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  /* The same dark ring the markers are drawn over, so a light dot still has
     an edge against the page. */
  box-shadow: 0 0 0 1px rgba(9, 9, 11, 0.8);
}
</style>
