<script setup>
// What the marker colours mean — and, where the picture can be filtered, what
// you press to see one kind of thing at a time.
//
// Every picture of a panel draws a component in the colour of its type
// (componentTypes.js), which is only readable with the key beside it — so the
// key sits under each picture, listing the types that are actually on this one
// rather than the whole catalogue. On a panel of a hundred markers the key is
// also the obvious place to ask "just the jacks, please": each entry toggles
// its own type, several may be on at once, and with none on the whole panel
// shows.

import { computed } from 'vue';
import { componentColor, typeLabel, typesPresent } from '../componentTypes.js';

const props = defineProps({
  // Components or panel placements — anything carrying a `type`.
  items: { type: Array, default: () => [] },
  // Whether the entries filter the picture they belong to. A key under a
  // picture nothing filters stays a key.
  selectable: { type: Boolean, default: false },
  // The types currently shown, or [] for all of them.
  selected: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:selected']);

const entries = computed(() =>
  typesPresent(props.items).map((type) => ({
    type,
    color: componentColor(type),
    on: props.selected.includes(type),
  }))
);

function toggle(type) {
  const next = props.selected.includes(type)
    ? props.selected.filter((t) => t !== type)
    : [...props.selected, type];
  emit('update:selected', next);
}
</script>

<template>
  <p v-if="entries.length" class="component-legend" data-test="component-legend">
    <component
      :is="selectable ? 'button' : 'span'"
      v-for="entry in entries"
      :key="entry.type"
      :type="selectable ? 'button' : undefined"
      :class="{ selectable, on: entry.on }"
      :aria-pressed="selectable ? String(entry.on) : undefined"
      :title="
        selectable
          ? entry.on
            ? `Showing only these — press to stop filtering by ${typeLabel(entry.type)}`
            : `Show only the ${typeLabel(entry.type)} on this panel`
          : undefined
      "
      :data-test="`legend-${entry.type}`"
      @click="selectable && toggle(entry.type)"
    >
      <span class="legend-dot" :style="{ background: entry.color }" aria-hidden="true"></span>
      {{ typeLabel(entry.type) }}
    </component>
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
.component-legend > span,
.component-legend > button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
/* A key entry that filters is a control, but it stays a key: no button chrome
   until it is pressed or pointed at. */
.component-legend > button.selectable {
  margin: 0;
  padding: 0.05rem 0.35rem;
  font: inherit;
  color: inherit;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
}
.component-legend > button.selectable:hover {
  border-color: var(--border-strong);
}
.component-legend > button.selectable.on {
  color: var(--text);
  background: var(--bg-2);
  border-color: var(--accent-2);
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
