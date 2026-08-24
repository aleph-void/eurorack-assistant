// How big the picture is drawn, and which part of it is on screen.
//
// Two things that only make sense together: the diagram is one coordinate
// space rendered at whatever CSS width we ask for, so the zoom IS that width
// — and what is on screen is the scroll box divided by it. Changing either
// invalidates the other, which is why they are one composable rather than two.
//
// Which KINDS of marker are drawn is a separate question, pressed in the key
// under the picture, and stays in PatchDiagram.vue beside the legend.
//
// Split out of PatchDiagram.vue, which is otherwise the picture itself.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { imageWidthFor, panelImageUrl } from '../../panelLayout.js';

// `wrap` is the scroll box, `container` the element that goes fullscreen, and
// `diagram` the laid-out picture (its width is what a fit fits).
export function useDiagramView({ wrap, container, diagram }) {
  // ---- the whole screen ----
  // Patching is close work on a picture that is far wider than the column this
  // page is laid out in, so the diagram can take the whole display: the panel
  // itself goes fullscreen, controls and all, and the picture refits to what it
  // is given.
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
  // How far short of each jack a cable's TAP HANDLE stops. The handle is three
  // times the drawn width (`.cable-hit`) and a round cap puts half of that
  // beyond the path's end, so a handle that ran all the way to the jack would
  // cover the marker and everything around it: a press on a patched jack would
  // answer with the cable. Cut back by the marker, its ring and that cap, and
  // the jack is the thing the jack answers with.
  const cableGap = computed(
    () => markerRadius.value + markerStroke.value + cableStroke.value * 1.5
  );
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

  return {
    fullscreen,
    toggleFullscreen,
    zoom,
    zoomBy,
    resetZoom,
    wheelZoom,
    zoomPercent,
    markerRadius,
    markerStroke,
    cableGap,
    MARKER_HALO,
    MARKER_NEUTRAL,
    MARKER_SELECTED,
    viewport,
    measureViewport,
    onScroll,
    inView,
    showMarkers,
    imageUrl,
    svgStyle,
  };
}
