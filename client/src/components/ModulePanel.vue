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

// A marker has to be seen against whatever the panel happens to look like, and
// panels are every colour there is: a violet ring vanishes on a purple Make
// Noise plate, a pale one vanishes on brushed aluminium. So the colour is the
// viewer's to choose, cycled through a handful that each win somewhere.
const MARKER_SCHEMES = [
  { name: 'Violet', ring: '#a78bfa', body: 'rgba(139, 92, 246, 0.2)', halo: 'rgba(9, 9, 11, 0.55)' },
  { name: 'Lime', ring: '#bef264', body: 'rgba(163, 230, 53, 0.25)', halo: 'rgba(9, 9, 11, 0.6)' },
  { name: 'Cyan', ring: '#67e8f9', body: 'rgba(34, 211, 238, 0.25)', halo: 'rgba(9, 9, 11, 0.6)' },
  { name: 'Magenta', ring: '#f472b6', body: 'rgba(236, 72, 153, 0.25)', halo: 'rgba(9, 9, 11, 0.6)' },
  { name: 'White', ring: '#ffffff', body: 'rgba(255, 255, 255, 0.25)', halo: 'rgba(9, 9, 11, 0.7)' },
  { name: 'Black', ring: '#09090b', body: 'rgba(9, 9, 11, 0.3)', halo: 'rgba(250, 250, 250, 0.7)' },
];

const SCHEME_KEY = 'panel-marker-scheme';

// Remembered between visits: someone with a rack of black panels should not
// have to re-pick the colour on every module they open.
function storedScheme() {
  try {
    const at = MARKER_SCHEMES.findIndex((s) => s.name === localStorage.getItem(SCHEME_KEY));
    return at < 0 ? 0 : at;
  } catch {
    return 0;
  }
}

const props = defineProps({
  panel: { type: Object, required: true },
  height: { type: Number, default: 560 },
  // Component ids to pick out (a jack the page is talking about).
  highlight: { type: Array, default: () => [] },
  // Whether markers may be dragged onto the hardware they name.
  editable: { type: Boolean, default: false },
  // When arranging one component, hide every other marker without changing
  // the underlying panel data. null leaves the complete panel visible.
  onlyComponentId: { type: Number, default: null },
});

const emit = defineEmits(['move']);

const svg = ref(null);
const schemeAt = ref(storedScheme());
const scheme = computed(() => MARKER_SCHEMES[schemeAt.value]);

// The colours the markers are drawn in, handed to the SVG as custom properties
// so every marker — plain, highlighted or held — moves together.
const schemeStyle = computed(() => ({
  '--marker-ring': scheme.value.ring,
  '--marker-body': scheme.value.body,
  '--marker-halo': scheme.value.halo,
}));

function cycleScheme() {
  schemeAt.value = (schemeAt.value + 1) % MARKER_SCHEMES.length;
  try {
    localStorage.setItem(SCHEME_KEY, scheme.value.name);
  } catch {
    // A browser that will not remember it is not a reason to refuse the change.
  }
}
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
    .filter(
      (placement) =>
        props.onlyComponentId === null || placement.component_id === props.onlyComponentId
    )
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
const markerCountText = computed(() =>
  props.onlyComponentId === null
    ? `${markers.value.length} component(s) located on it`
    : `${markers.value.length} of ${(props.panel.components ?? []).length} component(s) shown`
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
      :style="{ width: '100%', maxWidth: `${width}px`, ...schemeStyle }"
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
        <!-- A ring of the opposite colour behind the marker, so the marker has
             an edge to be seen against on a panel of its own colour. -->
        <circle :cx="m.cx" :cy="m.cy" r="11" class="marker-halo" />
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
    <div class="panel-tools">
      <button
        type="button"
        class="secondary marker-color"
        data-test="panel-marker-color"
        :title="`Marker colour: ${scheme.name} — press for the next one`"
        @click="cycleScheme"
      >
        <span class="swatch" :style="{ background: scheme.ring }" aria-hidden="true"></span>
        Marker colour: {{ scheme.name }}
      </button>
    </div>
    <figcaption class="muted">
      <template v-if="panel.source === 'upload'">
        Panel picture you uploaded — {{ markerCountText }}{{
          panel.hp ? `, ${panel.hp}HP wide` : ''
        }}.
      </template>
      <template v-else-if="panel.source === 'image'">
        Front panel image
        <a v-if="panel.source_url" :href="panel.source_url" target="_blank" rel="noreferrer">
          (source)
        </a>
        — {{ markerCountText }}.
      </template>
      <template v-else>
        No panel image was found, so this is a drawing made from the module's manual —
        {{ markerCountText }}{{ panel.hp ? `, ${panel.hp}HP wide` : '' }}.
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
.marker-halo {
  fill: none;
  stroke: var(--marker-halo);
  stroke-width: 3;
  pointer-events: none;
}
.marker {
  fill: var(--marker-body);
  stroke: var(--marker-ring);
  stroke-width: 2;
}
.marker.on {
  fill: var(--marker-ring);
  fill-opacity: 0.45;
  stroke-width: 3;
}
.marker.editable {
  cursor: grab;
}
.marker.held {
  cursor: grabbing;
  fill: var(--marker-ring);
  fill-opacity: 0.6;
  stroke-width: 3;
}
.panel-tools {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.marker-color {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.5rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
}
.swatch {
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
}
figcaption {
  font-size: 0.85rem;
  margin-top: 0.4rem;
}
</style>
