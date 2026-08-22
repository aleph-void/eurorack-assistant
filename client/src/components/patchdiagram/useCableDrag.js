// The two gestures on the picture: patching a cable, and moving the picture.
//
// A cable drag has already claimed the gesture by the time the pan sees it —
// pointerdown reaches the jack marker first and sets `dragging` — so patching
// wins, and alt/right-click is left to unplugging.
//
// Split out of PatchDiagram.vue, which is otherwise the picture itself.

import { computed, ref } from 'vue';
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
    // A finger already moves the picture: the box scrolls, and taking the
    // gesture over would replace the browser's own two-axis drag (with its
    // momentum, and its handover to the page at the edges) with a worse copy —
    // and, since claiming it means preventDefault, would leave a phone unable
    // to scroll PAST a diagram that is most of the screen.
    if (event.pointerType === 'touch') return;
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
    unplugCable,
    draftCable,
  };
}
