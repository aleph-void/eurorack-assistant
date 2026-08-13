<script setup>
// One module's front plate with its analyzed components marked on it — the
// same picture and the same positions the patch diagram draws cables between,
// shown on its own so you can check that the mapping is right.

import { computed } from 'vue';
import { placementFraction } from '../panelLayout.js';

const props = defineProps({
  panel: { type: Object, required: true },
  height: { type: Number, default: 560 },
  // Component ids to pick out (a jack the page is talking about).
  highlight: { type: Array, default: () => [] },
});

const crop = computed(() => ({
  x: props.panel.crop?.x ?? 0,
  y: props.panel.crop?.y ?? 0,
  w: props.panel.crop?.w || 1,
  h: props.panel.crop?.h || 1,
}));

const width = computed(() => {
  const ratio =
    (props.panel.width * crop.value.w) / (props.panel.height * crop.value.h);
  return Number.isFinite(ratio) && ratio > 0 ? Math.round(props.height * ratio) : 200;
});

const viewBox = computed(() => {
  const c = crop.value;
  const p = props.panel;
  return `${c.x * p.width} ${c.y * p.height} ${c.w * p.width} ${c.h * p.height}`;
});

const highlighted = computed(() => new Set(props.highlight));

const markers = computed(() =>
  (props.panel.components ?? [])
    .map((placement) => {
      const { fx, fy } = placementFraction(props.panel, placement);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
      return {
        ...placement,
        cx: Math.min(1, Math.max(0, fx)) * width.value,
        cy: Math.min(1, Math.max(0, fy)) * props.height,
        on: highlighted.value.has(placement.component_id),
      };
    })
    .filter(Boolean)
);
</script>

<template>
  <figure class="module-panel">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      :style="{ width: '100%', maxWidth: `${width}px` }"
      data-test="module-panel-svg"
    >
      <svg
        x="0"
        y="0"
        :width="width"
        :height="height"
        :viewBox="viewBox"
        preserveAspectRatio="none"
      >
        <image
          x="0"
          y="0"
          :width="panel.width"
          :height="panel.height"
          :href="panel.url"
          preserveAspectRatio="none"
        />
      </svg>
      <g v-for="m in markers" :key="m.name + m.cx">
        <circle :cx="m.cx" :cy="m.cy" r="9" class="marker" :class="{ on: m.on }">
          <title>{{ m.name }}</title>
        </circle>
      </g>
    </svg>
    <figcaption class="muted">
      <template v-if="panel.source === 'image'">
        Front panel image
        <a v-if="panel.source_url" :href="panel.source_url" target="_blank" rel="noreferrer">
          (source)
        </a>
        — {{ markers.length }} component(s) located on it.
      </template>
      <template v-else>
        No panel image was found, so this is a drawing made from the module's manual —
        {{ markers.length }} component(s) placed{{ panel.hp ? `, ${panel.hp}HP wide` : '' }}.
      </template>
    </figcaption>
  </figure>
</template>

<style scoped>
.module-panel {
  margin: 0;
}
.module-panel svg {
  height: auto;
  display: block;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.marker {
  fill: rgba(139, 92, 246, 0.15);
  stroke: rgba(228, 228, 231, 0.6);
  stroke-width: 2;
}
.marker.on {
  fill: rgba(139, 92, 246, 0.45);
  stroke: var(--accent-2);
}
figcaption {
  font-size: 0.85rem;
  margin-top: 0.4rem;
}
</style>
