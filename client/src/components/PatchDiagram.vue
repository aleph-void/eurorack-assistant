<script setup>
// The patch as a picture: each module's front panel side by side, with a
// cable drawn between the jacks every patch cable joins.
//
// Everything is one SVG in a single coordinate space (see panelLayout.js), so
// nothing has to be measured in the DOM and the whole diagram scales with the
// page. Panels come from the module analysis: a real front-panel photograph
// where one was found, otherwise the logical panel the server drew from the
// manual.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ComponentLegend from './ComponentLegend.vue';
import { componentColor } from '../componentTypes.js';
import {
  PANEL_HEIGHT,
  cableBounds,
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
  // The studio's own arrangement: the patch's frozen copy of every rack row,
  // each naming the patch-module ids standing in it and where its rack stood
  // on the system's floor plan. When present, the picture IS that plan.
  rackRows: { type: Array, default: () => [] },
  // The patch's routing switch sections (common jack + the steps it selects
  // between). Which way a switch's bidirectional jacks run is a fact about
  // the SECTION, not about each jack, so the picture needs the sections.
  switches: { type: Array, default: () => [] },
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

// ---- the whole screen ----
// Patching is close work on a picture that is far wider than the column this
// page is laid out in, so the diagram can take the whole display: the panel
// itself goes fullscreen, controls and all, and the picture refits to what it
// is given.
const container = ref(null);
const fullscreen = ref(false);

function toggleFullscreen() {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  container.value?.requestFullscreen?.();
}

function onFullscreenChange() {
  fullscreen.value = Boolean(document.fullscreenElement);
  // The box is a different size now: refit unless the user has taken the
  // zoom into their own hands, and re-measure what is on screen either way.
  nextTick(() => {
    if (!userZoomed.value) fitZoom();
    measureViewport();
  });
}

// ---- zoom ----
// The diagram is one coordinate space rendered at whatever CSS width we ask
// for, so zooming is just that width: every jack marker, cable and hit test
// goes through getBoundingClientRect and follows along. Patching is close
// work — a rack row is wider than any screen — so the picture opens fitted to
// the page and zooms from there, and stays where the user put it.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
// A whole studio fitted to the page lands around 15%, where a panel is a
// thumbnail and a jack is two pixels across — nothing on it can be read or
// patched. So the picture OPENS no smaller than this and scrolls instead;
// zooming out further is still there for taking in the whole room at once.
const FIT_MIN_ZOOM = 0.35;
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
  const fitted = Math.min(1, available / width);
  // 'Fit' means fit — it is asked for. Opening the page is not.
  zoom.value = clampZoom(userFitted ? fitted : Math.max(fitted, FIT_MIN_ZOOM));
}
function zoomBy(factor) {
  userZoomed.value = true;
  zoom.value = clampZoom(zoom.value * factor);
}
let userFitted = false;
function resetZoom() {
  userZoomed.value = false;
  userFitted = true;
  zoom.value = 1;
  fitZoom();
  userFitted = false;
}
// Ctrl/⌘ + wheel is the zoom gesture everywhere else that draws on a canvas,
// and it is what a trackpad pinch sends. A bare wheel still scrolls the
// diagram, which is what a bare wheel is for.
function wheelZoom(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  fitZoom();
  // The picture opens fitted to the page, so that is the size its panels are
  // wanted at — no need to wait out the settle timer for the first ones.
  imageZoom.value = zoom.value;
  // Measured now, not on the next tick: the box is in the document by the
  // time this runs, and waiting a tick would leave one frame with an empty
  // picture in it.
  measureViewport();
  window.addEventListener('resize', onScroll);
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  clearTimeout(imageZoomTimer);
  window.removeEventListener('resize', onScroll);
  if (viewportFrame) cancelAnimationFrame(viewportFrame);
});
// Zooming changes what a scroll position means, and so does redrawing the
// picture with different modules on it.
watch(zoom, () => nextTick(measureViewport));
// A diagram that changes shape (modules shown, names on, a row added) is
// refitted unless the user has taken the zoom into their own hands.
watch(
  () => diagram.value,
  () => {
    if (!userZoomed.value) fitZoom();
    nextTick(measureViewport);
  }
);
const zoomPercent = computed(() => Math.round(zoom.value * 100));

// A marker has to be the same size ON SCREEN however far the picture is
// zoomed out, or a whole studio draws its jacks as invisible specks: the
// radius is given in diagram units, so it is divided by the zoom. The clamp
// keeps it from swallowing the panel at the extremes — at 15% a panel is only
// a couple of hundred units wide.
const MARKER_SCREEN_R = 6;
const markerRadius = computed(() => clamp(MARKER_SCREEN_R / zoom.value, 2, 18));
const markerStroke = computed(() => clamp(1.5 / zoom.value, 0.5, 4.5));
// A cable is also the thing you alt-click to unplug, so it is never thinner
// on screen than a pointer can comfortably hit: the drawn width holds from
// 1:1 up, and below that the stroke is widened by the zoom, the same trick
// the markers use. Handed to the stylesheet as a custom property so the
// hover rule can thicken it further without a second binding per cable.
const CABLE_WIDTH = 7;
const cableStroke = computed(() => clamp(CABLE_WIDTH / zoom.value, CABLE_WIDTH, 26));
// The dark ring behind every marker, so a bright dot has an edge to be seen
// against on a photograph of a panel. Kept here rather than in the stylesheet
// because a marker's colours travel on the element itself — a rule in CSS
// would win over the component type's own colour.
const MARKER_HALO = 'rgba(9, 9, 11, 0.75)';
// A placement with no component behind it has no type and no colour of its
// own, and falls back to the module page's neutral marker.
const MARKER_NEUTRAL = '#e4e4e7';
// The ring around the marker being corrected, in place of its dark halo.
const MARKER_SELECTED = '#f4f4f5';

// ---- what is on screen ----
// A studio is two hundred panels and six thousand markers, and a picture of
// one is far wider than any screen: at any moment nearly all of it is scrolled
// out of sight. Building that part costs exactly what building the part you
// are looking at costs — the same nodes, the same panel images decoded — and
// shows nothing, so only the part inside the scroll box is drawn. Everything
// keeps its place in the coordinate space, so the scrollbars, the hit tests
// and the drag gesture are untouched by this.
//
// The margin is a band of diagram either side of the box, so a scroll finds
// the panels already there rather than arriving before them.
const VIEWPORT_MARGIN = 500;
// What is on screen is re-measured once a frame while scrolling, and every
// answer that DIFFERS invalidates the panels, the markers, the cables and
// their ends — a filter and a rebuild over six thousand anchors. A scroll of
// three pixels changes nothing about what is worth drawing, so the box is
// snapped out to a grid and only a box that has actually moved a grid step is
// written. The margin already covers the slack this adds.
const VIEWPORT_STEP = 250;
// Before there is anything to measure, the first screenful is GUESSED from
// the window: the box has not been laid out yet, and rendering the whole
// studio for one frame — every panel built, every image fetched — an instant
// before all but a screenful is thrown away is the most expensive moment on
// the page. The real measurement replaces this as soon as the box exists.
// null means 'measured, and the box has no size at all' — a test renderer
// with no layout — and then everything is drawn, because the honest answer
// to 'what is on screen' is 'no idea'.
const viewport = ref(
  typeof window === 'undefined'
    ? null
    : {
        x0: -VIEWPORT_MARGIN,
        y0: -VIEWPORT_MARGIN,
        x1: window.innerWidth + VIEWPORT_MARGIN,
        y1: window.innerHeight + VIEWPORT_MARGIN,
      }
);
let viewportFrame = 0;

// Snapped OUTWARD, so the box is always a superset of what is really on
// screen: nothing is culled that should have been drawn.
const down = (value) => Math.floor(value / VIEWPORT_STEP) * VIEWPORT_STEP;
const up = (value) => Math.ceil(value / VIEWPORT_STEP) * VIEWPORT_STEP;

function measureViewport() {
  const el = wrap.value;
  if (!el || !el.clientWidth || !el.clientHeight) {
    viewport.value = null;
    return;
  }
  const scale = zoom.value || 1;
  const next = {
    x0: down(el.scrollLeft / scale - VIEWPORT_MARGIN),
    y0: down(el.scrollTop / scale - VIEWPORT_MARGIN),
    x1: up((el.scrollLeft + el.clientWidth) / scale + VIEWPORT_MARGIN),
    y1: up((el.scrollTop + el.clientHeight) / scale + VIEWPORT_MARGIN),
  };
  const now = viewport.value;
  if (now && now.x0 === next.x0 && now.y0 === next.y0 && now.x1 === next.x1 && now.y1 === next.y1) {
    return;
  }
  viewport.value = next;
}

// Scrolling fires far faster than the screen redraws; measuring once per
// frame is as often as it can matter.
function onScroll() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    measureViewport();
  });
}

const inView = (box) => {
  const v = viewport.value;
  return !v || (box.x1 >= v.x0 && box.x0 <= v.x1 && box.y1 >= v.y0 && box.y0 <= v.y1);
};

// Zoomed out far enough, a marker is at its smallest and a panel is a couple
// of hundred pixels wide: drawing every knob, LED and button on it turns the
// case into a bead curtain and buries the jacks, which are the only things a
// cable can go in. So the furniture appears as you zoom in to where you could
// read it anyway. A jack is always drawn, at every zoom.
const CONTROL_ZOOM = 0.55;
const showControls = computed(() => zoom.value >= CONTROL_ZOOM);
// Zoomed out past this — a whole studio taken in at once — a marker is two
// pixels of a panel the size of a stamp, and six thousand of them are drawn
// for nothing. The picture is then the case itself; the cables are still on
// it, and the jacks come back as soon as anything can be read.
const MARKER_ZOOM = 0.25;
const showMarkers = computed(() => zoom.value >= MARKER_ZOOM);

// Each panel is fetched at the size it is actually painted — its drawn width,
// at the current zoom, at the screen's own pixel density. Widths come in a
// few fixed steps (panelLayout.js), so zooming re-requests a picture at most
// a couple of times and every step is cached from then on.
const density = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
// The zoom the panel pictures were last FETCHED at. A wheel gesture crosses
// several zoom steps in a second, and each one that changes the size bucket
// asks the server for another forty panels — pictures replaced before they
// arrive. So the request follows the zoom only once it has stopped moving.
const imageZoom = ref(1);
let imageZoomTimer = 0;
watch(zoom, (value) => {
  clearTimeout(imageZoomTimer);
  imageZoomTimer = setTimeout(() => {
    imageZoom.value = value;
  }, 250);
});
const imageUrl = (placed) =>
  panelImageUrl(
    placed.pm.panel,
    imageWidthFor(placed.pm.panel, placed.width) * imageZoom.value * density()
  );
const svgStyle = computed(() => ({
  width: `${Math.max(1, Math.round(diagram.value.width * zoom.value))}px`,
  maxWidth: 'none',
  '--cable-width': `${cableStroke.value}px`,
}));

// The panels inside the scroll box, and the instances they belong to. Markers
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

// ---- which way a mult runs, once something is plugged into it ----
// The jacks of a mult section are interchangeable HARDWARE: any of them can
// be the input. A patch decides which — the one a cable is plugged into is
// the input, and every other jack in the section carries a copy out — and
// that is the same rule the server patches by (routes/patches/helpers.js).
// So once a mult is fed, the picture stops calling its jacks bidirectional
// and draws the fed one as an input and the rest as outputs: in the type's
// own colour, offered for dragging the way an output is, and refused as a
// destination the way an output is.
//
// A section is: same instance, same group label, with the unlabelled
// bidirectional jacks of a module counting as one section — again as the
// server has it.
const BIDIRECTIONAL = 'bidirectional_jack';
const multSection = (patchModuleId, component) =>
  `${patchModuleId}:${(component.group_label || '').trim().toLowerCase()}`;
const jackKey = (patchModuleId, componentId) => `${patchModuleId}:${componentId}`;

// The jacks a cable is plugged into, and the jacks a cable LEAVES FROM. Both
// point a bidirectional jack: signal arriving at one makes it an input, and
// signal leaving one makes it an output. Reading only the arriving end left a
// switch whose common is patched onward — the many-to-one direction, four
// steps feeding one output — with every jack of it still drawn as undecided.
const fedJacks = computed(
  () => new Set(props.cables.map((c) => jackKey(c.to_patch_module_id, c.to_component_id)))
);
const sourcedJacks = computed(
  () => new Set(props.cables.map((c) => jackKey(c.from_patch_module_id, c.from_component_id)))
);

// A ROUTING SWITCH is not a mult, and the difference is the whole of this
// section: a switch SELECTS one of its steps, where a mult COPIES to all of
// them. So a Doepfer A-151's four step jacks are four alternative ends of ONE
// connection to the common jack, and cabling one of them says which way the
// whole section runs: a cable into a step makes every step an input and the
// common the output (many-to-one, one live at a time), a cable into the
// common makes the common the input and every step an output (one-to-many).
// It never makes the OTHER steps outputs — the signal does not come back out
// of them, and the mult rule below would say it did.
const switchSections = computed(() =>
  props.switches.map((section) => ({
    common: jackKey(section.common_patch_module_id, section.common_component_id),
    steps: (section.steps ?? []).map((step) => jackKey(step.patch_module_id, step.component_id)),
  }))
);
// Every jack that belongs to one, so the mult rule leaves them alone — the
// same exclusion the server's tracer makes (services/patchFlow.js).
const switchJackKeys = computed(() => {
  const keys = new Set();
  for (const section of switchSections.value) {
    keys.add(section.common);
    for (const step of section.steps) keys.add(step);
  }
  return keys;
});

// What each bidirectional jack IS in this patch, once the cables have pointed
// it one way: switch sections first, then the mult groups that are left.
const multDirections = computed(() => {
  const directions = new Map();
  const fed = fedJacks.value;
  const sourced = sourcedJacks.value;
  // Only a jack the hardware leaves open is given a direction; one the panel
  // already calls an input or an output is what it says it is.
  const points = (key, type) => {
    const [patchModuleId, componentId] = key.split(':').map(Number);
    if (componentAt(patchModuleId, componentId)?.type !== BIDIRECTIONAL) return;
    directions.set(key, type);
  };

  // A switch section runs ONE way, and either end of it can be the cable that
  // says which: signal arriving at the common (or leaving a step) runs
  // common → steps, and signal leaving the common (or arriving at a step)
  // runs steps → common. So a common patched into somebody's input is the
  // section's output and its four steps become inputs, which is the
  // many-to-one half of what a routing switch is for.
  for (const section of switchSections.value) {
    const commonIsInput =
      fed.has(section.common) || section.steps.some((step) => sourced.has(step));
    const commonIsOutput =
      sourced.has(section.common) || section.steps.some((step) => fed.has(step));
    // Nothing patched yet, or driven at both ends: the section says nothing
    // about which way it runs, so its jacks stay bidirectional.
    if (commonIsInput === commonIsOutput) continue;
    points(section.common, commonIsInput ? 'input_jack' : 'output_jack');
    for (const step of section.steps) points(step, commonIsInput ? 'output_jack' : 'input_jack');
  }

  const multFed = new Map();
  for (const cable of props.cables) {
    const key = jackKey(cable.to_patch_module_id, cable.to_component_id);
    if (switchJackKeys.value.has(key)) continue;
    const component = componentAt(cable.to_patch_module_id, cable.to_component_id);
    if (component?.type !== BIDIRECTIONAL) continue;
    multFed.set(multSection(cable.to_patch_module_id, component), component.id);
  }
  // A mult jack a cable LEAVES is carrying a copy out, so it is an output
  // whether or not the patch has said yet which of its siblings the copy is
  // of. The siblings stay bidirectional: a mult takes its input at exactly
  // one of them and nothing here knows which, and a second copy may still be
  // dragged out of any of the others.
  for (const key of sourced) {
    if (switchJackKeys.value.has(key)) continue;
    points(key, 'output_jack');
  }
  if (multFed.size === 0) return directions;
  for (const pm of props.modules) {
    for (const component of pm.components ?? []) {
      if (component.type !== BIDIRECTIONAL) continue;
      if (switchJackKeys.value.has(jackKey(pm.id, component.id))) continue;
      const input = multFed.get(multSection(pm.id, component));
      if (input === undefined) continue;
      points(jackKey(pm.id, component.id), input === component.id ? 'input_jack' : 'output_jack');
    }
  }
  return directions;
});

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

// Dragging the picture moves it, the way a map is moved. A studio is far
// wider than any screen and the scroll bar is a long way from the panel being
// patched, so pressing on anything that is NOT a jack and dragging scrolls the
// box under the pointer. A cable drag has already claimed the gesture by the
// time this sees it — pointerdown reaches the jack first and sets `dragging` —
// so patching still wins, and alt/right-click is left to unplugging.
const panning = ref(null);
// The elements with a gesture of their own: a jack marker, the jack editor's
// controls, anything clickable.
const OWN_GESTURE = 'circle, .jack-editor, input, select, button, a, textarea';

function startPan(event) {
  if (dragging.value || panning.value) return;
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target?.closest?.(OWN_GESTURE)) return;
  const el = wrap.value;
  if (!el) return;
  event.preventDefault();
  panning.value = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: el.scrollLeft,
    top: el.scrollTop,
  };
  el.setPointerCapture?.(event.pointerId);
}

function movePan(event) {
  const pan = panning.value;
  const el = wrap.value;
  if (!pan || !el || event.pointerId !== pan.id) return;
  el.scrollLeft = pan.left - (event.clientX - pan.x);
  el.scrollTop = pan.top - (event.clientY - pan.y);
}

function endPan(event) {
  const pan = panning.value;
  if (!pan || event.pointerId !== pan.id) return;
  wrap.value?.releasePointerCapture?.(event.pointerId);
  panning.value = null;
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
