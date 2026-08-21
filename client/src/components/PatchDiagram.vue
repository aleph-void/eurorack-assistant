<script setup>
// The patch as a picture: each module's front panel side by side, with a
// cable drawn between the jacks every patch cable joins.
//
// Everything is one SVG in a single coordinate space (see panelLayout.js), so
// nothing has to be measured in the DOM and the whole diagram scales with the
// page. Panels come from the module analysis: a real front-panel photograph
// where one was found, otherwise the logical panel the server drew from the
// manual.

import { computed, onMounted, ref, watch } from 'vue';
import ComponentLegend from './ComponentLegend.vue';
import { componentColor } from '../componentTypes.js';
import {
  PANEL_HEIGHT,
  cableColor,
  cablePath,
  imageWidthFor,
  layoutDiagram,
  panelImageUrl,
  usedModules,
} from '../panelLayout.js';

const props = defineProps({
  modules: { type: Array, default: () => [] },
  cables: { type: Array, default: () => [] },
  // How the parent names an instance ("Make Noise Maths #2 (ghost layer)").
  labelFor: { type: Function, default: null },
  // The patch editor can connect a physical output to a physical input by
  // dragging between their markers. Read-only diagrams keep their old view.
  interactive: { type: Boolean, default: false },
  // Saved physical rack rows, expressed as patch-module ids. When present,
  // they determine the diagram's row breaks and instance order.
  rackRows: { type: Array, default: () => [] },
});
const emit = defineEmits(['connect', 'disconnect', 'retype']);

// A patch snapshots the whole rack, so by default only the modules it
// actually uses are drawn — the rest would bury them.
const showAll = ref(false);
const showJackNames = ref(false);
// Panels are drawn edge to edge the way they stand in the case, so there is
// nowhere for a name to go without pushing them apart again: names are on the
// panels themselves and under the pointer, and this puts them back in a band
// above each panel for anyone who wants to read the rack.
const showModuleNames = ref(false);

const label = (pm) =>
  props.labelFor ? props.labelFor(pm) : `${pm.manufacturer} ${pm.module_name}`.trim();

// A patch with no cables yet uses no modules, and drawing the whole rack in
// that case buries the diagram in panels the patch has nothing to do with —
// so an unpatched patch draws nothing until 'show every module' is ticked.
const visibleModules = computed(() =>
  showAll.value ? props.modules : usedModules(props.modules, props.cables)
);
const organized = computed(() => {
  if (!props.rackRows.length) return { modules: visibleModules.value, rowStarts: [] };
  const byId = new Map(props.modules.map((module) => [module.id, module]));
  const visible = new Set(visibleModules.value.map((module) => module.id));
  const picked = new Set();
  const modules = [];
  const rowStarts = [];
  for (const row of props.rackRows) {
    const rowModules = (row.modules || []).map((id) => byId.get(id)).filter((module) => module && visible.has(module.id));
    if (!rowModules.length) continue;
    rowStarts.push(modules.length);
    rowModules.forEach((module) => picked.add(module.id));
    modules.push(...rowModules);
  }
  // A patch is a snapshot; modules added after arranging the rack remain
  // visible below the organized rows rather than vanishing from the patch.
  const unplaced = visibleModules.value.filter((module) => !picked.has(module.id));
  if (unplaced.length && modules.length) rowStarts.push(modules.length);
  modules.push(...unplaced);
  return { modules, rowStarts };
});
const shown = computed(() => organized.value.modules);

const diagram = computed(() =>
  layoutDiagram(shown.value, {
    height: PANEL_HEIGHT,
    rowStarts: organized.value.rowStarts,
    // A physical rack row is never folded in two — it scrolls. Only a diagram
    // with no rack layout behind it wraps to keep itself on the page.
    wrap: !organized.value.rowStarts.length,
    labels: showModuleNames.value,
  })
);

// ---- zoom ----
// The diagram is one coordinate space rendered at whatever CSS width we ask
// for, so zooming is just that width: every jack marker, cable and hit test
// goes through getBoundingClientRect and follows along. Patching is close
// work — a rack row is wider than any screen — so the picture opens fitted to
// the page and zooms from there, and stays where the user put it.
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
const wrap = ref(null);
const zoom = ref(1);
const userZoomed = ref(false);
const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function fitZoom() {
  const available = (wrap.value?.clientWidth ?? 0) - 18; // the wrap's padding
  const width = diagram.value.width;
  // jsdom (and a wrap that has not been laid out yet) measures nothing;
  // 1:1 is the honest answer then.
  if (available <= 0 || !width) return;
  zoom.value = clampZoom(Math.min(1, available / width));
}
function zoomBy(factor) {
  userZoomed.value = true;
  zoom.value = clampZoom(zoom.value * factor);
}
function resetZoom() {
  userZoomed.value = false;
  zoom.value = 1;
  fitZoom();
}
// Ctrl/⌘ + wheel is the zoom gesture everywhere else that draws on a canvas,
// and it is what a trackpad pinch sends. A bare wheel still scrolls the
// diagram, which is what a bare wheel is for.
function wheelZoom(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}
onMounted(fitZoom);
// A diagram that changes shape (modules shown, names on, a row added) is
// refitted unless the user has taken the zoom into their own hands.
watch(
  () => diagram.value.width,
  () => {
    if (!userZoomed.value) fitZoom();
  }
);
const zoomPercent = computed(() => Math.round(zoom.value * 100));

// Each panel is fetched at the size it is actually painted — its drawn width,
// at the current zoom, at the screen's own pixel density. Widths come in a
// few fixed steps (panelLayout.js), so zooming re-requests a picture at most
// a couple of times and every step is cached from then on.
const density = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
const imageUrl = (placed) =>
  panelImageUrl(placed.pm.panel, imageWidthFor(placed.pm.panel, placed.width) * zoom.value * density());
const svgStyle = computed(() => ({
  width: `${Math.max(1, Math.round(diagram.value.width * zoom.value))}px`,
  maxWidth: 'none',
}));

const anchorFor = (patchModuleId, componentId) =>
  componentId === null || componentId === undefined
    ? null
    : diagram.value.anchors.get(`${patchModuleId}:${componentId}`) ?? null;

const moduleName = (patchModuleId) => {
  const pm = props.modules.find((m) => m.id === patchModuleId);
  return pm ? label(pm) : 'unknown module';
};

// The cables both of whose ends landed on a jack we know the position of.
// One that did not (a cable to a jack the panel could not place at all) is
// counted instead, so the diagram says what it is not showing.
const drawn = computed(() =>
  props.cables
    .map((cable, index) => {
      const from = anchorFor(cable.from_patch_module_id, cable.from_component_id);
      const to = anchorFor(cable.to_patch_module_id, cable.to_component_id);
      if (!from || !to) return null;
      return {
        cable,
        d: cablePath(from, to, index),
        color: cableColor(index),
        from,
        to,
        title:
          `${moduleName(cable.from_patch_module_id)} ${cable.from_component_name}` +
          ` → ${moduleName(cable.to_patch_module_id)} ${cable.to_component_name}` +
          (cable.note ? ` — ${cable.note}` : ''),
      };
    })
    .filter(Boolean)
);

// Cable ends, so a patched jack is marked even when its panel drew nothing
// there.
const ends = computed(() =>
  drawn.value.flatMap((c) => [
    { point: c.from, color: c.color, key: `${c.cable.id}-from` },
    { point: c.to, color: c.color, key: `${c.cable.id}-to` },
  ])
);

const undrawn = computed(() => props.cables.length - drawn.value.length);

const componentAt = (patchModuleId, componentId) =>
  props.modules.find((pm) => pm.id === patchModuleId)?.components.find((c) => c.id === componentId) ?? null;

const allAnchors = computed(() =>
  [...diagram.value.anchors.entries()].map(([key, anchor]) => {
    const [patchModuleId, componentId] = key.split(':').map(Number);
    const component = componentAt(patchModuleId, componentId);
    return {
      key,
      patchModuleId,
      componentId,
      component,
      // Every marker is drawn in the colour of its component type, the same
      // colours the module page marks the same panel in (componentTypes.js).
      color: component ? componentColor(component.type) : null,
      ...anchor,
    };
  })
);
// The key under the picture: what is actually on this diagram, not the whole
// catalogue of types.
const shownComponents = computed(() => allAnchors.value.map((a) => a.component).filter(Boolean));
// What a cable may be dragged TO, and what it may be dragged FROM. A
// bidirectional jack is both: which way it runs is decided by the patch, so
// the diagram lets it be either end and the server's cable rules decide
// whether that particular cable is legal.
const CABLE_IN = ['input_jack', 'bidirectional_jack'];
const CABLE_OUT = ['output_jack', 'bidirectional_jack'];
const inputs = computed(() => allAnchors.value.filter((a) => CABLE_IN.includes(a.component?.type)));

// ---- correcting a jack's direction ----
// The analysis reads a mult's jacks as plain inputs or outputs often enough
// that the correction belongs where the mistake shows: click the marker in
// the diagram. It is a fact about the HARDWARE, so it is written to the
// module and every patch drawing that module follows.
const JACK_TYPES = [
  { value: 'input_jack', label: 'Input' },
  { value: 'output_jack', label: 'Output' },
  { value: 'bidirectional_jack', label: 'Bidirectional (mult / bridged)' },
];
const selected = ref(null);
const retypeTo = ref('');
const selectedJack = computed(() => {
  if (!selected.value) return null;
  const pm = props.modules.find((m) => m.id === selected.value.patchModuleId);
  const component = pm?.components?.find((c) => c.id === selected.value.componentId);
  if (!pm || !component || !String(component.type).endsWith('_jack')) return null;
  return { pm, component };
});
function selectJack(anchor) {
  if (!props.interactive) return;
  selected.value =
    selected.value?.componentId === anchor.componentId &&
    selected.value?.patchModuleId === anchor.patchModuleId
      ? null
      : { patchModuleId: anchor.patchModuleId, componentId: anchor.componentId };
  retypeTo.value = selectedJack.value?.component.type ?? '';
}
function applyRetype() {
  const jack = selectedJack.value;
  if (!jack || !retypeTo.value || retypeTo.value === jack.component.type) return;
  emit('retype', {
    module_id: jack.pm.module_id,
    patch_module_id: jack.pm.id,
    component_id: jack.component.id,
    name: jack.component.name,
    type: retypeTo.value,
  });
  selected.value = null;
}

const svg = ref(null);
const dragging = ref(null);

function pointAt(event) {
  const box = svg.value?.getBoundingClientRect();
  if (!box?.width || !box?.height) return null;
  return {
    x: ((event.clientX - box.left) / box.width) * diagram.value.width,
    y: ((event.clientY - box.top) / box.height) * diagram.value.height,
  };
}

function startCable(anchor, event) {
  if (!props.interactive) return;
  const point = pointAt(event);
  if (!point) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture?.(event.pointerId);
  dragging.value = { source: anchor, point };
}

function moveCable(event) {
  if (!dragging.value) return;
  const point = pointAt(event);
  if (point) dragging.value = { ...dragging.value, point };
}

function finishCable(event) {
  if (!dragging.value) return;
  const point = pointAt(event);
  const source = dragging.value.source;
  dragging.value = null;
  if (!point) return;
  // The SVG has a fixed coordinate system but a responsive display size. A
  // 14px target feels the same at every zoom level.
  const radius = (14 / (svg.value?.getBoundingClientRect().width || 1)) * diagram.value.width;
  const target = inputs.value.find((input) => Math.hypot(input.x - point.x, input.y - point.y) <= radius);
  if (!target) return;
  emit('connect', {
    from_patch_module_id: source.patchModuleId,
    from_component_id: source.componentId,
    to_patch_module_id: target.patchModuleId,
    to_component_id: target.componentId,
  });
}

// Unplugging from the picture: the same alt-click / right-click gesture the
// rack organizer uses to pull a module out of a row. The parent does the
// write, so a read-only diagram keeps the browser's own context menu.
function unplugCable(cable, event) {
  if (!props.interactive) return;
  event.preventDefault();
  emit('disconnect', cable);
}

const draftCable = computed(() =>
  dragging.value ? cablePath(dragging.value.source, dragging.value.point, drawn.value.length) : null
);
</script>

<template>
  <details open class="panel" data-test="diagram">
    <summary>
      <h2>Patch diagram</h2>
      <span class="summary-count">
        {{ drawn.length }} {{ drawn.length === 1 ? 'cable' : 'cables' }} drawn
      </span>
    </summary>
    <div class="panel-body">
      <div class="diagram-controls">
        <label class="inline-check">
          <input v-model="showAll" type="checkbox" data-test="diagram-show-all" />
          Show every module in the rack
        </label>
        <label class="inline-check">
          <input v-model="showJackNames" type="checkbox" data-test="diagram-jack-names" />
          Label every jack
        </label>
        <label class="inline-check">
          <input v-model="showModuleNames" type="checkbox" data-test="diagram-module-names" />
          Name every module
        </label>
        <span class="zoom-controls">
          <button
            type="button"
            class="secondary"
            title="Zoom out"
            data-test="diagram-zoom-out"
            @click="zoomBy(1 / 1.25)"
          >
            −
          </button>
          <span class="zoom-level" data-test="diagram-zoom-level">{{ zoomPercent }}%</span>
          <button
            type="button"
            class="secondary"
            title="Zoom in"
            data-test="diagram-zoom-in"
            @click="zoomBy(1.25)"
          >
            +
          </button>
          <button
            type="button"
            class="secondary"
            title="Fit the whole diagram to the page"
            data-test="diagram-zoom-fit"
            @click="resetZoom"
          >
            Fit
          </button>
        </span>
      </div>

      <p v-if="shown.length === 0" class="muted" data-test="diagram-empty">
        Nothing to draw yet — patch a cable, or tick 'show every module'.
      </p>
      <template v-else>
        <div ref="wrap" class="diagram-wrap" @wheel="wheelZoom">
          <svg
            ref="svg"
            class="patch-diagram"
            :viewBox="`0 0 ${diagram.width} ${diagram.height}`"
            :style="svgStyle"
            data-test="diagram-svg"
            @pointermove="moveCable"
            @pointerup="finishCable"
            @pointercancel="dragging = null"
          >
            <!-- One panel per module instance: the image, cropped to the
                 front plate, with the module's name above it. -->
            <g v-for="placed in diagram.panels" :key="placed.pm.id">
              <title>{{ label(placed.pm) }}</title>
              <text v-if="showModuleNames" :x="placed.x" :y="placed.labelY" class="panel-label">
                {{ label(placed.pm) }}
              </text>
              <svg
                v-if="placed.pm.panel"
                :x="placed.x"
                :y="placed.y"
                :width="placed.width"
                :height="placed.height"
                :viewBox="`${placed.pm.panel.crop.x * placed.pm.panel.width} ${
                  placed.pm.panel.crop.y * placed.pm.panel.height
                } ${placed.pm.panel.crop.w * placed.pm.panel.width} ${
                  placed.pm.panel.crop.h * placed.pm.panel.height
                }`"
                preserveAspectRatio="none"
              >
                <image
                  x="0"
                  y="0"
                  :width="placed.pm.panel.width"
                  :height="placed.pm.panel.height"
                  :href="imageUrl(placed)"
                  preserveAspectRatio="none"
                />
              </svg>
              <rect
                v-else
                :x="placed.x"
                :y="placed.y"
                :width="placed.width"
                :height="placed.height"
                class="panel-blank"
              />
              <text
                v-if="!placed.pm.panel"
                :x="placed.x + placed.width / 2"
                :y="placed.y + 20"
                class="panel-blank-label"
              >
                no panel
              </text>
              <rect
                :x="placed.x"
                :y="placed.y"
                :width="placed.width"
                :height="placed.height"
                class="panel-frame"
              />
            </g>

            <!-- Every jack we know the position of, so an empty one still
                 reads as somewhere a cable could go. -->
            <circle
              v-for="a in allAnchors"
              :key="a.key"
              :cx="a.x"
              :cy="a.y"
              r="6"
              class="jack-marker"
              :stroke="a.color"
              :class="{
                patchable: CABLE_OUT.includes(a.component?.type),
                jack: Boolean(a.component?.type?.endsWith('_jack')),
                selected:
                  selected?.patchModuleId === a.patchModuleId &&
                  selected?.componentId === a.componentId,
              }"
              :data-test="`diagram-jack-${a.patchModuleId}-${a.componentId}`"
              @pointerdown="CABLE_OUT.includes(a.component?.type) && startCable(a, $event)"
              @click="selectJack(a)"
            >
              <title>{{ a.name }}{{ a.component ? ` (${a.component.type})` : '' }}</title>
            </circle>

            <path v-if="draftCable" :d="draftCable" class="cable draft-cable" />

            <path
              v-for="c in drawn"
              :key="c.cable.id"
              :d="c.d"
              class="cable"
              :class="{ optional: c.cable.optional, unpluggable: interactive }"
              :stroke="c.color"
              :data-test="`diagram-cable-${c.cable.id}`"
              @click.alt="unplugCable(c.cable, $event)"
              @contextmenu="unplugCable(c.cable, $event)"
            >
              <title>{{ c.title }}{{ interactive ? ' — alt- or right-click to unplug' : '' }}</title>
            </path>
            <circle
              v-for="end in ends"
              :key="end.key"
              :cx="end.point.x"
              :cy="end.point.y"
              r="7"
              class="cable-end"
              :fill="end.color"
            />

            <template v-if="showJackNames">
              <text
                v-for="a in allAnchors"
                :key="`name-${a.key}`"
                :x="a.x"
                :y="a.y - 10"
                class="jack-label"
              >
                {{ a.name }}
              </text>
            </template>
          </svg>
        </div>
        <div v-if="interactive && selectedJack" class="jack-editor" data-test="diagram-jack-editor">
          <span>
            <strong>{{ selectedJack.component.name }}</strong>
            on {{ label(selectedJack.pm) }}
          </span>
          <template v-if="selectedJack.pm.module_id">
            <select v-model="retypeTo" data-test="diagram-jack-type">
              <option v-for="t in JACK_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
            <button
              type="button"
              style="margin: 0"
              :disabled="retypeTo === selectedJack.component.type"
              data-test="diagram-jack-retype"
              @click="applyRetype"
            >
              Change direction
            </button>
            <span class="muted" style="font-size: 0.8rem">
              Corrects the module itself, so every patch that draws it follows.
            </span>
          </template>
          <span v-else class="muted" style="font-size: 0.8rem">
            This connection point was declared on the patch — change its direction where it was
            added, under 'gear and extra connections'.
          </span>
          <button
            type="button"
            class="secondary"
            style="margin: 0 0 0 auto"
            data-test="diagram-jack-close"
            @click="selected = null"
          >
            Close
          </button>
        </div>

        <p v-if="undrawn > 0" class="muted" data-test="diagram-undrawn">
          {{ undrawn }} {{ undrawn === 1 ? 'cable is' : 'cables are' }} not drawn — an end of
          {{ undrawn === 1 ? 'it' : 'them' }} is a connection point with no place on a panel.
        </p>
        <ComponentLegend :items="shownComponents" />
        <p class="muted" style="font-size: 0.85rem">
          <template v-if="interactive">
            Drag an output marker (or a bidirectional one) onto an input marker to patch it — the
            key above says which colour is which; click any jack marker to correct which direction
            it runs. Ctrl- or ⌘-scroll zooms the picture. Controls and other component types
            cannot be wired here.
            <br />
          </template>
          Panels are the front plates found for each module, or a drawing made from its manual
          where no picture was found. A jack the picture does not place is out of frame and is
          not drawn — patch it from the cable list below, and correct where it sits on the
          module's own page.
        </p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.diagram-controls {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.zoom-controls {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
}
.zoom-controls button {
  margin: 0;
  padding: 0.15rem 0.55rem;
  line-height: 1.4;
}
.zoom-level {
  min-width: 3.4em;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.diagram-wrap {
  overflow: auto;
  /* Zoomed in, the diagram is bigger than the page: it scrolls inside its own
     box so the controls above it stay put while patching. */
  max-height: 80vh;
  overscroll-behavior: contain;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem;
}
.patch-diagram {
  height: auto;
  display: block;
}
.panel-label {
  fill: var(--accent-2);
  font-size: 19px;
  font-weight: 600;
}
.panel-frame {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 2;
}
.panel-blank {
  fill: var(--panel-2);
  stroke: var(--border-strong);
  stroke-width: 2;
  stroke-dasharray: 6 5;
}
.panel-blank-label {
  fill: var(--faint);
  font-size: 15px;
  text-anchor: middle;
}
/* The stroke is the component type's colour, set on the circle itself
   (componentTypes.js), so nothing here may set one. A marker whose component
   the patch no longer holds keeps the neutral below. */
.jack-marker {
  fill: none;
  stroke: rgba(228, 228, 231, 0.55);
  stroke-width: 1.5;
}
/* A hole a cable goes in is drawn heavier than a control: the diagram is for
   patching, and the controls are on it for orientation. */
.jack-marker.jack {
  stroke-width: 2.5;
}
.jack-marker.patchable {
  cursor: crosshair;
}
.jack-marker.selected {
  fill: rgba(228, 228, 231, 0.25);
  stroke-width: 4;
}
.jack-editor {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-top: 0.6rem;
  padding: 0.5rem 0.7rem;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.jack-editor select {
  margin: 0;
  width: auto;
}
.jack-label {
  fill: var(--muted);
  font-size: 15px;
}
.jack-label {
  text-anchor: middle;
}
.cable {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
  opacity: 0.85;
}
.cable:hover {
  stroke-width: 8;
  opacity: 1;
}
.cable.unpluggable {
  cursor: pointer;
}
.cable.optional {
  stroke-dasharray: 14 10;
  opacity: 0.6;
}
.draft-cable {
  stroke: var(--accent-2);
  stroke-dasharray: 8 6;
  opacity: 0.9;
  pointer-events: none;
}
.cable-end {
  stroke: var(--bg);
  stroke-width: 1.5;
}
</style>
