<script setup>
// The patch as a picture: each module's front panel side by side, with a
// cable drawn between the jacks every patch cable joins.
//
// Everything is one SVG in a single coordinate space (see panelLayout.js), so
// nothing has to be measured in the DOM and the whole diagram scales with the
// page. Panels come from the module analysis: a real front-panel photograph
// where one was found, otherwise the logical panel the server drew from the
// manual.

import { computed, ref } from 'vue';
import ComponentLegend from './ComponentLegend.vue';
import { componentColor } from '../componentTypes.js';
import {
  PANEL_HEIGHT,
  cableBounds,
  cableColor,
  cablePath,
  layoutDiagram,
  usedModules,
} from '../panelLayout.js';
import { useDiagramView } from './patchdiagram/useDiagramView.js';
import { useMultDirections } from './patchdiagram/useMultDirections.js';
import { useCableDrag } from './patchdiagram/useCableDrag.js';

const props = defineProps({
  modules: { type: Array, default: () => [] },
  cables: { type: Array, default: () => [] },
  // How the parent names an instance ("Make Noise Maths #2 (ghost layer)").
  labelFor: { type: Function, default: null },
  // The patch editor can connect a physical output to a physical input by
  // dragging between their markers. Read-only diagrams keep their old view.
  interactive: { type: Boolean, default: false },
  // The studio's own arrangement: the patch's frozen copy of every rack row,
  // each naming the patch-module ids standing in it and where its rack stood
  // on the system's floor plan. When present, the picture IS that plan.
  rackRows: { type: Array, default: () => [] },
  // The patch's routing switch sections (common jack + the steps it selects
  // between). Which way a switch's bidirectional jacks run is a fact about
  // the SECTION, not about each jack, so the picture needs the sections.
  switches: { type: Array, default: () => [] },
  // The patch's mult sections, resolved onto instances by the server: which
  // bidirectional jacks are copies of each other. Usually that is the group
  // label on the jack, but a SWITCHED multiple (A-182-1) decides it with a
  // toggle per jack, so the picture cannot read it off the component either.
  // A jack whose toggle the patch has not recorded stands in every section it
  // might be on, which is why a jack can appear in more than one.
  mults: { type: Array, default: () => [] },
});
const emit = defineEmits(['connect', 'disconnect', 'retype']);

// A patch snapshots the whole rack, and the rack is what the picture is OF:
// the case in front of you, with the patched jacks marked on it. So every
// module is drawn by default — untick this to see only the ones a cable
// touches. (Only what is on screen is ever built, so a whole studio costs
// what a corner of it costs.)
const showAll = ref(true);
const showJackNames = ref(false);
// Panels are drawn edge to edge the way they stand in the case, so there is
// nowhere for a name to go without pushing them apart again: names are on the
// panels themselves and under the pointer, and this puts them back in a band
// above each panel for anyone who wants to read the rack.
const showModuleNames = ref(false);

const label = (pm) =>
  props.labelFor ? props.labelFor(pm) : `${pm.manufacturer} ${pm.module_name}`.trim();

const visibleModules = computed(() =>
  showAll.value ? props.modules : usedModules(props.modules, props.cables)
);
const organized = computed(() => {
  if (!props.rackRows.length) return { modules: visibleModules.value, rows: null };
  const byId = new Map(props.modules.map((module) => [module.id, module]));
  const visible = new Set(visibleModules.value.map((module) => module.id));
  const picked = new Set();
  const modules = [];
  // Every row of the studio, in its own place — including the ones with
  // nothing visible on them, so a hidden row does not slide the rows below it
  // up the case.
  const rows = props.rackRows.map((row) => {
    const rowModules = (row.modules || [])
      .map((id) => byId.get(id))
      .filter((module) => module && visible.has(module.id));
    rowModules.forEach((module) => picked.add(module.id));
    modules.push(...rowModules);
    return { ...row, modules: rowModules };
  });
  // A patch is a snapshot; modules added after arranging the rack remain
  // visible below the studio rather than vanishing from the patch.
  const unplaced = visibleModules.value.filter((module) => !picked.has(module.id));
  if (unplaced.length) {
    // Standing on their own, below the whole studio: a plan y no rack can
    // have puts them in the last band of the floor (panelLayout.js).
    const hp = props.rackRows.reduce((widest, row) => Math.max(widest, Number(row.hp) || 0), 84);
    rows.push({
      id: 'unplaced',
      rack_id: 'unplaced',
      rack_x: 0,
      rack_y: Number.MAX_SAFE_INTEGER,
      unit: 3,
      hp,
      modules: unplaced,
    });
    modules.push(...unplaced);
  }
  return { modules, rows, unplaced };
});
const shown = computed(() => organized.value.modules);

const diagram = computed(() =>
  layoutDiagram(shown.value, {
    height: PANEL_HEIGHT,
    // The studio as its floor plan has it, when the patch carries one.
    rows: organized.value.rows,
    // A physical rack row is never folded in two — it scrolls. Only a diagram
    // with no rack layout behind it wraps to keep itself on the page.
    wrap: !organized.value.rows,
    labels: showModuleNames.value,
  })
);


// How big the picture is drawn and which part of it is on screen — the zoom,
// the fullscreen panel, the culled viewport and every size derived from them.
const container = ref(null);
const wrap = ref(null);
const {
  fullscreen,
  toggleFullscreen,
  zoomBy,
  resetZoom,
  wheelZoom,
  zoomPercent,
  markerRadius,
  markerStroke,
  MARKER_HALO,
  MARKER_NEUTRAL,
  MARKER_SELECTED,
  onScroll,
  inView,
  showControls,
  showMarkers,
  imageUrl,
  svgStyle,
} = useDiagramView({ wrap, container, diagram });

// are culled with their panel: a marker is only ever ON one.
const visiblePanels = computed(() =>
  diagram.value.panels.filter((placed) =>
    inView({ x0: placed.x, y0: placed.y, x1: placed.x + placed.width, y1: placed.y + placed.height })
  )
);
const visibleModuleIds = computed(() => new Set(visiblePanels.value.map((placed) => placed.pm.id)));

const anchorFor = (patchModuleId, componentId) =>
  componentId === null || componentId === undefined
    ? null
    : diagram.value.anchors.get(`${patchModuleId}:${componentId}`) ?? null;

// A studio is two hundred instances and six thousand components, and both of
// these are asked once per marker: scanning the arrays for each one is a
// million comparisons every time a cable changes what a mult jack is.
// Indexed once per payload instead.
const moduleById = computed(() => new Map(props.modules.map((pm) => [pm.id, pm])));
const componentByJack = computed(() => {
  const map = new Map();
  for (const pm of props.modules) {
    for (const component of pm.components ?? []) map.set(`${pm.id}:${component.id}`, component);
  }
  return map;
});

const moduleName = (patchModuleId) => {
  const pm = moduleById.value.get(patchModuleId);
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
        // The box the curve hangs in, so a cable across the studio is drawn
        // whenever any part of it is on screen — including the middle of a
        // cable whose two ends are both off it.
        box: cableBounds(from, to, index),
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

// A cable is on screen when any part of its curve is, whether or not either
// panel it runs between is.
const visibleCables = computed(() => drawn.value.filter((c) => inView(c.box)));

// Cable ends, so a patched jack is marked even when its panel drew nothing
// there.
const ends = computed(() =>
  visibleCables.value.flatMap((c) => [
    { point: c.from, color: c.color, key: `${c.cable.id}-from` },
    { point: c.to, color: c.color, key: `${c.cable.id}-to` },
  ])
);

const undrawn = computed(() => props.cables.length - drawn.value.length);

// Modules the patch holds that the studio's rows do not place — a copy the
// rack organizer never put in a row, or one added after the arrangement was
// made. They are drawn on their own below the floor, which reads as a mistake
// unless the picture says what it is.
const unplaced = computed(() => organized.value.unplaced ?? []);

const componentAt = (patchModuleId, componentId) =>
  componentByJack.value.get(`${patchModuleId}:${componentId}`) ?? null;


// Which way each bidirectional jack runs in THIS patch, once the cables have
// pointed it: switch sections first, then the mult groups that are left.
const { switchJackKeys, multDirections } = useMultDirections(props, componentAt);


// Every marker on the whole picture, as the HARDWARE has it: what a panel
// places, which component is behind it, and nothing the cables can change.
// A studio's worth of these is six thousand objects, so building them is kept
// off the path a cable takes — plugging one only re-points the handful of
// mult jacks the patch has decided the direction of (`directed` below).
const anchorBase = computed(() =>
  [...diagram.value.anchors.entries()].map(([key, anchor]) => {
    const [patchModuleId, componentId] = key.split(':').map(Number);
    return {
      key,
      patchModuleId,
      componentId,
      component: componentAt(patchModuleId, componentId),
      ...anchor,
    };
  })
);

// What one connector is IN THIS PATCH: its own type, unless it is a mult jack
// the patch has given a direction.
const directedType = (a) => multDirections.value.get(a.key) ?? a.component?.type ?? null;
const directed = (a) => {
  const component = a.component;
  const type = directedType(a);
  return {
    ...a,
    type,
    // A mult jack that the patch has pointed one way is drawn as what it
    // now is, so the picture and the cable rules never disagree.
    multed: Boolean(component) && type !== component.type,
    // …and a switch jack says so in its own words: a switch SELECTS one of
    // its steps where a mult COPIES to all of them, so 'a copy of what is
    // patched in' is the one thing a step is not.
    switched: switchJackKeys.value.has(a.key),
    // Every marker is drawn in the colour of its component type, the same
    // colours the module page marks the same panel in (componentTypes.js).
    color: component ? componentColor(type) : MARKER_NEUTRAL,
  };
};
// The markers built into the picture: the ones on a panel that is on screen.
// Everything else about a marker — the legend below, what a cable may be
// dragged to — is a fact about the whole diagram and keeps counting them all,
// so scrolling never changes what the picture SAYS, only what it draws.
// A direction only ever re-points a jack (a mult jack to an input or an
// output), so the cheap test on the component's own type is the same test.
const visibleAnchors = computed(() => {
  if (!showMarkers.value) return [];
  return anchorBase.value
    .filter(
      (a) =>
        visibleModuleIds.value.has(a.patchModuleId) &&
        (showControls.value || Boolean(a.component?.type?.endsWith('_jack')))
    )
    .map(directed);
});

// The key under the picture: what is actually on this diagram, not the whole
// catalogue of types — and a mult the patch has pointed one way counts as
// what it is now, so the key never names a colour the picture is not using.
const shownComponents = computed(() =>
  anchorBase.value.filter((a) => a.component).map((a) => ({ type: directedType(a) }))
);
// What a cable may be dragged TO, and what it may be dragged FROM. A
// bidirectional jack is both: which way it runs is decided by the patch, so
// the diagram lets it be either end and the server's cable rules decide
// whether that particular cable is legal.
const CABLE_IN = ['input_jack', 'bidirectional_jack'];
const CABLE_OUT = ['output_jack', 'bidirectional_jack'];
// Read only when a drag is dropped, over the whole diagram: a cable may be
// dropped on a jack that is off screen the moment the picture scrolls under
// the pointer.
const inputs = computed(() => anchorBase.value.filter((a) => CABLE_IN.includes(directedType(a))));

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
  const pm = moduleById.value.get(selected.value.patchModuleId);
  const component = componentAt(selected.value.patchModuleId, selected.value.componentId);
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

// The two gestures on the picture: patching a cable, and moving the picture
// the way a map is moved.
const svg = ref(null);
const {
  dragging,
  startCable,
  moveCable,
  finishCable,
  panning,
  startPan,
  movePan,
  endPan,
  unplugCable,
  draftCable,
} = useCableDrag({
  props,
  emit,
  svg,
  wrap,
  diagram,
  inputs,
  drawnCount: computed(() => drawn.value.length),
});

</script>

<template>
  <details ref="container" open class="panel" :class="{ fullscreen }" data-test="diagram">
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
          <button
            type="button"
            class="secondary"
            :title="fullscreen ? 'Leave full screen' : 'Fill the screen with the diagram'"
            data-test="diagram-fullscreen"
            @click="toggleFullscreen"
          >
            {{ fullscreen ? 'Exit full screen' : 'Full screen' }}
          </button>
        </span>
      </div>

      <p v-if="shown.length === 0" class="muted" data-test="diagram-empty">
        Nothing to draw yet — patch a cable, or tick 'show every module'.
      </p>
      <template v-else>
        <div
          ref="wrap"
          class="diagram-wrap"
          :class="{ panning }"
          @wheel="wheelZoom"
          @scroll="onScroll"
          @pointerdown="startPan"
          @pointermove="movePan"
          @pointerup="endPan"
          @pointercancel="endPan"
        >
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
            <g v-for="placed in visiblePanels" :key="placed.pm.id">
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
              v-for="a in visibleAnchors"
              :key="a.key"
              :cx="a.x"
              :cy="a.y"
              :r="markerRadius"
              class="jack-marker"
              :fill="a.color"
              :stroke="
                selected?.patchModuleId === a.patchModuleId &&
                selected?.componentId === a.componentId
                  ? MARKER_SELECTED
                  : MARKER_HALO
              "
              :stroke-width="markerStroke"
              :class="{
                patchable: CABLE_OUT.includes(a.type),
                jack: Boolean(a.type?.endsWith('_jack')),
                selected:
                  selected?.patchModuleId === a.patchModuleId &&
                  selected?.componentId === a.componentId,
              }"
              :data-test="`diagram-jack-${a.patchModuleId}-${a.componentId}`"
              @pointerdown="CABLE_OUT.includes(a.type) && startCable(a, $event)"
              @click="selectJack(a)"
            >
              <title>
                {{ a.name
                }}{{
                  a.multed
                    ? a.switched
                      ? a.type === 'input_jack'
                        ? ' (switch input — it comes out at the other side of the section)'
                        : ' (switch output — whichever step the switch has selected)'
                      : a.type === 'input_jack'
                        ? ' (this mult\'s input)'
                        : ' (mult output — a copy of what is patched into it)'
                    : a.component
                      ? ` (${a.component.type})`
                      : ''
                }}
              </title>
            </circle>

            <path v-if="draftCable" :d="draftCable" class="cable draft-cable" />

            <path
              v-for="c in visibleCables"
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
                v-for="a in visibleAnchors"
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

        <p v-if="unplaced.length" class="muted" data-test="diagram-unplaced">
          {{ unplaced.length }} {{ unplaced.length === 1 ? 'module stands' : 'modules stand' }}
          below the studio — {{ unplaced.length === 1 ? 'it is' : 'they are' }} not placed in any
          row of {{ unplaced.length === 1 ? 'its' : 'their' }} rack:
          {{ unplaced.map((pm) => label(pm)).join(', ') }}. Put
          {{ unplaced.length === 1 ? 'it' : 'them' }} in a row on the
          <RouterLink to="/racks">Organize rack</RouterLink> page, then match this patch to the
          layout again.
        </p>
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
/* Fullscreen: the element is on its own black backdrop with none of the
   page's own background behind it, and the picture is given every pixel that
   is not one of the diagram's own controls. */
.panel:fullscreen {
  background: var(--bg);
  overflow: auto;
  padding: 0.6rem 1rem 1rem;
}
.panel:fullscreen .diagram-wrap {
  max-height: calc(100vh - 7.5rem);
}
.diagram-wrap {
  overflow: auto;
  /* The background of the picture is a handle: press it and drag to move the
     case around, rather than reaching for the scroll bars. */
  cursor: grab;
  /* Zoomed in, the diagram is bigger than the page: it scrolls inside its own
     box so the controls above it stay put while patching. */
  max-height: 80vh;
  overscroll-behavior: contain;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem;
}
/* On a phone the picture is nearly the whole screen at 80vh, and it holds
   its own scrolling (`overscroll-behavior: contain`) — so there has to be
   page left above and below it to take hold of. */
@media (max-width: 767px) {
  .diagram-wrap {
    max-height: 60vh;
  }
}
.diagram-wrap.panning {
  cursor: grabbing;
  user-select: none;
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
/* Every colour a marker is drawn in rides on the circle itself — the type's
   own colour as its fill (componentTypes.js), a dark ring around it for
   contrast — so nothing here may set a fill or a stroke or it would win over
   the type. Only how SOLID the marker is belongs here: a hole a cable goes in
   is filled, a control is a faint disc, because the diagram is for patching
   and the controls are on it for orientation. */
.jack-marker {
  fill-opacity: 0.35;
}
.jack-marker.jack {
  fill-opacity: 0.95;
}
.jack-marker.patchable {
  cursor: crosshair;
}
.jack-marker.selected {
  fill-opacity: 1;
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
  /* Set on the <svg> from the zoom, so a cable stays hittable when the whole
     studio is fitted to the page. */
  stroke-width: var(--cable-width, 7px);
  stroke-linecap: round;
  opacity: 0.85;
}
.cable:hover {
  stroke-width: calc(var(--cable-width, 7px) * 1.5);
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
