<script setup>
// Moving between the pages of one panel without a trip through the drawer:
// one chip per kind of thing this module actually has, in the colour every
// picture of a panel draws that kind in, with the count of them beside the
// name. The chips are the same visual vocabulary as the legend under the
// pictures, so they read at a glance as "what is on this module" — and the
// lit one is the page you are on. A type the module has none of gets no
// chip (the all-components page still has a section for adding one), except
// the type of the page being read, or the row would not say where you are.
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { COMPONENT_TYPES, TYPE_LABELS, componentColor } from '../../componentTypes.js';

const props = defineProps({
  module: { type: Object, default: null },
  moduleId: { type: String, required: true },
  // The type whose page this is, or 'all' on the all-components page.
  current: { type: String, required: true },
});

// The rack the reader is walking rides on every jump, as it does on the
// drawer's links and on previous/next.
const route = useRoute();
const suffix = computed(() => (route.query.rack ? `?rack=${route.query.rack}` : ''));

// The same two route shapes the router serves: the jacks by what a cable
// does at them, the rest by their type.
const JACK_PATHS = {
  input_jack: 'jacks/input',
  output_jack: 'jacks/output',
  bidirectional_jack: 'jacks/bidirectional',
};
const typePath = (type) => JACK_PATHS[type] ?? `parts/${type}`;

const chips = computed(() => {
  const counts = new Map();
  for (const c of props.module?.components || []) {
    counts.set(c.type, (counts.get(c.type) || 0) + 1);
  }
  return COMPONENT_TYPES.filter((type) => counts.has(type) || type === props.current).map(
    (type) => ({
      type,
      label: TYPE_LABELS[type] || type,
      count: counts.get(type) || 0,
      color: componentColor(type),
      to: `/modules/${props.moduleId}/${typePath(type)}${suffix.value}`,
      on: type === props.current,
    })
  );
});
</script>

<template>
  <nav v-if="module" class="type-nav" aria-label="Component types" data-test="type-nav">
    <RouterLink
      class="type-chip"
      :class="{ on: current === 'all' }"
      :aria-current="current === 'all' ? 'page' : undefined"
      :to="`/modules/${moduleId}/components${suffix}`"
      data-test="type-nav-all"
    >
      All components
      <span class="type-chip-count">{{ (module.components || []).length }}</span>
    </RouterLink>
    <RouterLink
      v-for="chip in chips"
      :key="chip.type"
      class="type-chip"
      :class="{ on: chip.on }"
      :aria-current="chip.on ? 'page' : undefined"
      :to="chip.to"
      :data-test="`type-nav-${chip.type}`"
    >
      <span class="type-chip-dot" :style="{ background: chip.color }" aria-hidden="true"></span>
      {{ chip.label }}
      <span class="type-chip-count">{{ chip.count }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.type-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0.6rem 0 0.9rem;
}
.type-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--muted);
}
.type-chip:hover {
  color: var(--text);
  border-color: var(--accent);
  text-decoration: none;
}
.type-chip.on {
  color: var(--text);
  background: var(--accent-glow);
  border-color: var(--accent);
}
.type-chip-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  /* The same dark ring the markers are drawn over, so a light dot still has
     an edge against the page. */
  box-shadow: 0 0 0 1px rgba(9, 9, 11, 0.8);
}
.type-chip-count {
  font-family: var(--font-mono);
  font-size: 0.72rem;
}
</style>
