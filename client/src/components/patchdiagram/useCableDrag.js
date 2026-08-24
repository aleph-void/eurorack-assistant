// The two MOUSE gestures on the picture: dragging a cable between two jacks,
// and dragging the picture itself the way a map is moved.
//
// A cable drag has already claimed the gesture by the time the pan sees it —
// pointerdown reaches the jack marker first and sets `dragging` — so patching
// wins, and alt/right-click is left to unplugging.
//
// Neither is a TOUCH gesture: a finger scrolls the picture, which is the
// gesture the diagram deliberately leaves to the browser, so a drag started
// under one would be cancelled the moment it moved. Patching and unplugging
// by tap live in PatchDiagram.vue, beside the bars that do the asking.
//
// Split out of PatchDiagram.vue, which is otherwise the picture itself.

import { computed, onBeforeUnmount, ref } from 'vue';
import { cablePath } from '../../panelLayout.js';

// `svg` is the drawing surface (the coordinate space a pointer is read into),
// `wrap` the scroll box a pan scrolls, `diagram` the laid-out picture,
// `inputs` every marker a cable may be dropped on, and `drawnCount` how many
// cables are already drawn (a draft is coloured as the next one).
export function useCableDrag({ props, emit, svg, wrap, diagram, inputs, drawnCount }) {
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
    // A finger scrolls the picture instead — the same reason `startPan` leaves
    // touch to the browser — so a drag started here would be cancelled the
    // moment it moved, and the preventDefault below can swallow the tap that
    // follows it. Touch patches in two taps (`patchFrom` above); this is the
    // mouse's gesture and says so.
    if (event.pointerType === 'touch') return;
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
    dragPointer = { clientX: event.clientX, clientY: event.clientY };
    if (!scrollFrame) scrollFrame = requestAnimationFrame(edgeScroll);
  }

  // ---- scrolling at the edge ----
  // A studio is far wider than any screen, so the jack a dragged cable is
  // headed for is often not on it — and the hand is on the drag: letting go
  // to reach the scroll bar drops the cable. So holding the drag near an edge
  // of the scroll box scrolls the picture that way, faster the nearer the
  // edge; the pointer capture keeps the moves coming past it, where the speed
  // tops out. The scrolling is a rAF loop rather than work per pointer event
  // — the house rule, and also the only thing that keeps the picture moving
  // while the pointer HOLDS STILL at the edge, when no event arrives at all.
  const EDGE = 48; // how far from an edge the scrolling starts, in px
  const EDGE_SPEED = 24; // px per frame hard against the edge
  let dragPointer = null; // where the dragged cable last was, in client px
  let scrollFrame = 0;

  // How hard one axis pushes: nothing inside the band, up to full speed at
  // (or beyond) the edge itself.
  function edgePush(at, low, high) {
    if (at < low + EDGE) return -Math.min(1, (low + EDGE - at) / EDGE);
    if (at > high - EDGE) return Math.min(1, (at - (high - EDGE)) / EDGE);
    return 0;
  }

  function edgeScroll() {
    scrollFrame = 0;
    const el = wrap.value;
    if (!dragging.value || !el || !dragPointer) return;
    const box = el.getBoundingClientRect();
    // A box with no size (a test renderer with no layout) has no edges.
    if (!box.width || !box.height) return;
    const dx = edgePush(dragPointer.clientX, box.left, box.right);
    const dy = edgePush(dragPointer.clientY, box.top, box.bottom);
    // Out of the band: the loop rests until the next pointer move re-arms it.
    if (!dx && !dy) return;
    const { scrollLeft, scrollTop } = el;
    el.scrollLeft = scrollLeft + dx * EDGE_SPEED;
    el.scrollTop = scrollTop + dy * EDGE_SPEED;
    // Pinned against the end of the scroll range: nothing left to scroll to.
    if (el.scrollLeft === scrollLeft && el.scrollTop === scrollTop) return;
    // The picture slid under a pointer that may be holding still, so the
    // draft cable's end follows it the way a pointer move would have made it.
    const point = pointAt(dragPointer);
    if (point) dragging.value = { ...dragging.value, point };
    scrollFrame = requestAnimationFrame(edgeScroll);
  }

  function stopEdgeScroll() {
    dragPointer = null;
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }
  onBeforeUnmount(stopEdgeScroll);

  function finishCable(event) {
    if (!dragging.value) return;
    stopEdgeScroll();
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
  // A cable joins them the moment it can be unplugged: pressing one means THIS
  // CABLE, and a pan takes a pointer capture, which retargets the click that
  // would have said so. A read-only diagram's cables answer to nothing, so
  // there they stay part of the background you take hold of.
  const panGesture = computed(() =>
    props.interactive ? `${OWN_GESTURE}, .cable, .cable-hit` : OWN_GESTURE
  );

  function startPan(event) {
    if (dragging.value || panning.value) return;
    // A finger already moves the picture: the box scrolls, and taking the
    // gesture over would replace the browser's own two-axis drag (with its
    // momentum, and its handover to the page at the edges) with a worse copy —
    // and, since claiming it means preventDefault, would leave a phone unable
    // to scroll PAST a diagram that is most of the screen.
    if (event.pointerType === 'touch') return;
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target?.closest?.(panGesture.value)) return;
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

  const draftCable = computed(() =>
    dragging.value ? cablePath(dragging.value.source, dragging.value.point, drawnCount.value) : null
  );

  return {
    dragging,
    startCable,
    moveCable,
    finishCable,
    panning,
    startPan,
    movePan,
    endPan,
    draftCable,
  };
}
