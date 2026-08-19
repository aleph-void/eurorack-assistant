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
import {
  PANEL_HEIGHT,
  cableColor,
  cablePath,
  layoutDiagram,
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
const emit = defineEmits(['connect']);

// A patch snapshots the whole rack, so by default only the modules it
// actually uses are drawn — the rest would bury them.
const showAll = ref(false);
const showJackNames = ref(false);

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

const diagram = computed(() => layoutDiagram(shown.value, { height: PANEL_HEIGHT, rowStarts: organized.value.rowStarts }));

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

// Jacks with no place on the picture are drawn in a strip under the panel and
// always carry their name — otherwise a dot below a module means nothing.
const spareLabels = computed(() =>
  diagram.value.panels.flatMap((placed) =>
    placed.spare
      .map((jack) => ({
        key: `${placed.pm.id}:${jack.id}`,
        anchor: diagram.value.anchors.get(`${placed.pm.id}:${jack.id}`),
        name: jack.name,
      }))
      .filter((s) => s.anchor)
  )
);

const componentAt = (patchModuleId, componentId) =>
  props.modules.find((pm) => pm.id === patchModuleId)?.components.find((c) => c.id === componentId) ?? null;

const allAnchors = computed(() =>
  [...diagram.value.anchors.entries()].map(([key, anchor]) => {
    const [patchModuleId, componentId] = key.split(':').map(Number);
    const component = componentAt(patchModuleId, componentId);
    return { key, patchModuleId, componentId, component, ...anchor };
  })
);
const inputs = computed(() => allAnchors.value.filter((a) => a.component?.type === 'input_jack'));

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
      </div>

      <p v-if="shown.length === 0" class="muted" data-test="diagram-empty">
        Nothing to draw yet — patch a cable, or tick 'show every module'.
      </p>
      <template v-else>
        <div class="diagram-wrap">
          <svg
            ref="svg"
            class="patch-diagram"
            :viewBox="`0 0 ${diagram.width} ${diagram.height}`"
            :style="{ width: '100%', maxWidth: `${diagram.width}px` }"
            data-test="diagram-svg"
            @pointermove="moveCable"
            @pointerup="finishCable"
            @pointercancel="dragging = null"
          >
            <!-- One panel per module instance: the image, cropped to the
                 front plate, with the module's name above it. -->
            <g v-for="placed in diagram.panels" :key="placed.pm.id">
              <text :x="placed.x" :y="placed.labelY" class="panel-label">
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
                  :href="placed.pm.panel.url"
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
              :class="{ output: a.component?.type === 'output_jack', input: a.component?.type === 'input_jack' }"
              :data-test="`diagram-jack-${a.patchModuleId}-${a.componentId}`"
              @pointerdown="a.component?.type === 'output_jack' && startCable(a, $event)"
            >
              <title>{{ a.name }}{{ a.component ? ` (${a.component.type})` : '' }}</title>
            </circle>

            <path v-if="draftCable" :d="draftCable" class="cable draft-cable" />

            <!-- Jacks with no place on the picture sit below the panel and
                 say what they are. -->
            <text
              v-for="s in spareLabels"
              :key="`label-${s.key}`"
              :x="s.anchor.x + 9"
              :y="s.anchor.y + 4"
              class="spare-label"
            >
              {{ s.name }}
            </text>

            <path
              v-for="c in drawn"
              :key="c.cable.id"
              :d="c.d"
              class="cable"
              :class="{ optional: c.cable.optional }"
              :stroke="c.color"
              :data-test="`diagram-cable-${c.cable.id}`"
            >
              <title>{{ c.title }}</title>
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
        <p v-if="undrawn > 0" class="muted" data-test="diagram-undrawn">
          {{ undrawn }} {{ undrawn === 1 ? 'cable is' : 'cables are' }} not drawn — an end of
          {{ undrawn === 1 ? 'it' : 'them' }} is a connection point with no place on a panel.
        </p>
        <p class="muted" style="font-size: 0.85rem">
          <template v-if="interactive">
            Drag a blue output marker to a green input marker to patch it. Controls and other jack types cannot be wired here.
            <br />
          </template>
          Panels are the front plates found for each module, or a drawing made from its manual
          where no picture was found. A jack the panel could not place is shown in the strip
          underneath it.
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
.diagram-wrap {
  overflow-x: auto;
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
.jack-marker {
  fill: none;
  stroke: rgba(228, 228, 231, 0.55);
  stroke-width: 1.5;
}
.jack-marker.output {
  cursor: crosshair;
  stroke: var(--accent-2);
  stroke-width: 2.5;
}
.jack-marker.input {
  stroke: #4ade80;
  stroke-width: 2;
}
.jack-label,
.spare-label {
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
