<script setup>
// One module's front plate with its analyzed components marked on it — the
// same picture and the same positions the patch diagram draws cables between,
// shown on its own so you can check that the mapping is right.
//
// And, when it is not right, fix it: a marker can be dragged onto the hardware
// it names, which is saved where it is dropped. Everything that put the marker
// there in the first place was an estimate, and the person looking at the
// photograph can simply see the answer.

import { computed, ref } from 'vue';
import { placementFraction } from '../panelLayout.js';

const props = defineProps({
  panel: { type: Object, required: true },
  height: { type: Number, default: 560 },
  // Component ids to pick out (a jack the page is talking about).
  highlight: { type: Array, default: () => [] },
  // Whether markers may be dragged onto the hardware they name.
  editable: { type: Boolean, default: false },
});

const emit = defineEmits(['move']);

const svg = ref(null);
// The marker being dragged, and where it has been dragged to — held apart from
// the panel prop so the circle follows the pointer without a round trip, and
// so a failed save leaves nothing behind.
const dragging = ref(null);

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
      const held = dragging.value?.id === placement.id ? dragging.value : null;
      const { fx, fy } = held
        ? { fx: held.fx, fy: held.fy }
        : placementFraction(props.panel, placement);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
      return {
        ...placement,
        cx: Math.min(1, Math.max(0, fx)) * width.value,
        cy: Math.min(1, Math.max(0, fy)) * props.height,
        on: highlighted.value.has(placement.component_id),
        held: Boolean(held),
      };
    })
    .filter(Boolean)
);

// What the marker says when you rest on it: which control it is, and what the
// manual says that control does.
const tip = (m) => (m.description ? `${m.name} — ${m.description}` : m.name);

// A pointer position as a fraction of the panel as drawn. The SVG scales to
// its container, so the box it actually occupies is what the arithmetic has to
// use rather than the viewBox it was authored in.
function fractionAt(event) {
  const box = svg.value?.getBoundingClientRect();
  if (!box || !box.width || !box.height) return null;
  return {
    fx: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    fy: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
  };
}

function startDrag(marker, event) {
  if (!props.editable || marker.id == null) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture?.(event.pointerId);
  const at = fractionAt(event) ?? {
    fx: marker.cx / width.value,
    fy: marker.cy / props.height,
  };
  dragging.value = { id: marker.id, name: marker.name, ...at, from: at, moved: false };
}

// Held down and moved somewhere else. A press that never actually goes
// anywhere is a click, not a correction, and must not save the marker back on
// top of itself.
function onDrag(event) {
  const held = dragging.value;
  if (!held) return;
  const at = fractionAt(event);
  if (!at) return;
  dragging.value = {
    ...held,
    ...at,
    moved: held.moved || at.fx !== held.from.fx || at.fy !== held.from.fy,
  };
}

// Dropped: hand the new position back as a fraction of the WHOLE image, which
// is what the panel stores and what survives a change of crop.
function endDrag() {
  const held = dragging.value;
  dragging.value = null;
  if (!held?.moved) return;
  const c = crop.value;
  emit('move', {
    id: held.id,
    name: held.name,
    x: c.x + held.fx * c.w,
    y: c.y + held.fy * c.h,
  });
}
</script>

<template>
  <figure class="module-panel">
    <svg
      ref="svg"
      :viewBox="`0 0 ${width} ${height}`"
      :style="{ width: '100%', maxWidth: `${width}px` }"
      data-test="module-panel-svg"
      @pointermove="onDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
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
      <g v-for="m in markers" :key="m.id ?? m.name + m.cx">
        <circle
          :cx="m.cx"
          :cy="m.cy"
          r="9"
          class="marker"
          :class="{ on: m.on, editable, held: m.held }"
          :data-test="`panel-marker-${m.component_id ?? m.name}`"
          @pointerdown="startDrag(m, $event)"
        >
          <title>{{ tip(m) }}</title>
        </circle>
      </g>
    </svg>
    <figcaption class="muted">
      <template v-if="panel.source === 'upload'">
        Panel picture you uploaded — {{ markers.length }} component(s) located on it{{
          panel.hp ? `, ${panel.hp}HP wide` : ''
        }}.
      </template>
      <template v-else-if="panel.source === 'image'">
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
      <template v-if="editable">
        Rest on a marker to see what it does, or drag one onto the hardware it names if it has
        landed in the wrong place.
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
  touch-action: none;
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
.marker.editable {
  cursor: grab;
}
.marker.held {
  cursor: grabbing;
  fill: rgba(139, 92, 246, 0.55);
  stroke: var(--accent-2);
}
figcaption {
  font-size: 0.85rem;
  margin-top: 0.4rem;
}
</style>
