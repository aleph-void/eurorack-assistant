// Dragging a module into, along and out of a rack row.
//
// A press is not yet a drag: nothing is picked up until the cursor has
// travelled far enough to mean one, so a press that never moves is still the
// click (or the alt-click that pulls a module off a row) it looks like.
//
// Everything here is rAF-throttled — pointer moves arrive far faster than the
// screen redraws, and each one moved the ghost (redrawing every module in
// every row) and measured every slot in the row under the cursor. The FIRST
// move of a frame is acted on at once and only the ones crowding in behind it
// wait, so a gesture that has just begun has no frame of lag and a cursor that
// has come to rest still leaves the drop bar where it stopped.
//
// Split out of RacksView.vue, which is otherwise the organizer itself.

import { onBeforeUnmount, ref } from 'vue';

// `organizer` is the rack being arranged, `dragged`/`dropHint` the gesture's
// own state (the template draws both), and `rowUsed`, `refuse` and
// `saveLayout` are the organizer's rules about what a row will hold.
export function useRackDrag({ organizer, dragged, dropHint, rowUsed, refuse, saveLayout }) {
  const DRAG_THRESHOLD = 4;
  // Where the module in hand is drawn, in client coordinates.
  const dragPoint = ref({ x: 0, y: 0 });
  // The press, before the cursor has travelled far enough to mean a drag: a
  // press that never moves is a click — focus, or the alt-click that pulls a
  // module off its row — so nothing is picked up until it does.
  let pressed = null;

  function onModuleMouseDown(module, rowIndex, index, unit, event) {
    // Left button only, and never the alt/ctrl press that removes a placement.
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    // Stops the text selection (and the browser's own image drag) a press on a
    // panel would start. That also costs the button the focus a click gives it,
    // which is put back by hand: the arrow keys step whatever is focused.
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    pressed = { module, rowIndex, index, unit, x: event.clientX, y: event.clientY };
    window.addEventListener('mousemove', onDragMove, true);
    window.addEventListener('mouseup', onDragUp, true);
  }

  function startDrag(press) {
    // Inventory entries use `id`; persisted row placements use `module_id`.
    // Normalize once at the gesture boundary so a first drop saves the actual
    // module id rather than an undefined placement. A placement also carries
    // WHICH copy is in hand — a row may hold two of the same module, and the
    // one dragged is the one that has to move.
    dragged.value = {
      module: { ...press.module, module_id: press.module.module_id ?? press.module.id },
      rowIndex: press.rowIndex,
      index: press.index,
      unit: press.unit,
    };
    window.addEventListener('wheel', onDragWheel, wheelOptions);
    window.addEventListener('keydown', onDragKey, true);
    window.addEventListener('blur', endDrag);
  }

  function endDrag() {
    cancelAim();
    pressed = null;
    dragged.value = null;
    dropHint.value = null;
    window.removeEventListener('mousemove', onDragMove, true);
    window.removeEventListener('mouseup', onDragUp, true);
    window.removeEventListener('wheel', onDragWheel, wheelOptions);
    window.removeEventListener('keydown', onDragKey, true);
    window.removeEventListener('blur', endDrag);
  }

  // Escape puts the module back down where it was, the one thing a native drag
  // gave for free.
  function onDragKey(event) {
    if (event.key !== 'Escape' || !dragged.value) return;
    event.preventDefault();
    endDrag();
  }

  // Pointer moves arrive far faster than the screen redraws, and each one of
  // them moved the ghost (redrawing the whole organizer, every module in every
  // row) and measured every slot in the row under the cursor (a layout flush).
  // Once a frame is as often as either can matter.
  //
  // The FIRST move of a frame is acted on at once, and only the ones crowding in
  // behind it wait: a gesture that has just begun must not have a frame of lag,
  // and a cursor that has come to rest must still leave the drop bar where it
  // stopped.
  let aimFrame = 0;
  let pendingAim = null;
  let aimedAt = null;

  function aimSoon(clientX, clientY) {
    if (aimFrame) {
      pendingAim = { x: clientX, y: clientY };
      return;
    }
    aimedAt = { x: clientX, y: clientY };
    aimAt(clientX, clientY);
    aimFrame = requestAnimationFrame(() => {
      aimFrame = 0;
      const next = pendingAim;
      pendingAim = null;
      if (next && (next.x !== aimedAt.x || next.y !== aimedAt.y)) aimSoon(next.x, next.y);
    });
  }

  function cancelAim() {
    if (aimFrame) cancelAnimationFrame(aimFrame);
    aimFrame = 0;
    pendingAim = null;
    aimedAt = null;
  }

  function onDragMove(event) {
    if (pressed && !dragged.value) {
      const travelled =
        Math.abs(event.clientX - pressed.x) >= DRAG_THRESHOLD ||
        Math.abs(event.clientY - pressed.y) >= DRAG_THRESHOLD;
      if (!travelled) return;
      startDrag(pressed);
    }
    if (!dragged.value) return;
    event.preventDefault();
    aimSoon(event.clientX, event.clientY);
  }

  async function onDragUp(event) {
    if (!dragged.value) {
      // A press that never became a drag: leave the click alone.
      endDrag();
      return;
    }
    event.preventDefault();
    await finishDrag(hintAt(event.clientX, event.clientY));
  }

  // Where the cursor is: the module in hand is drawn there and the drop bar is
  // worked out for whatever is under it.
  function aimAt(clientX, clientY) {
    dragPoint.value = { x: clientX, y: clientY };
    dropHint.value = hintAt(clientX, clientY);
  }

  // What a drop right here would do: a slot in a row, back to Available, or
  // nothing at all. The module in hand never answers elementFromPoint (the
  // ghost is pointer-events: none), so what is under the cursor is the box the
  // drop lands in.
  function hintAt(clientX, clientY) {
    const under = document.elementFromPoint?.(clientX, clientY);
    const slots = under?.closest?.('.rack-row-slots');
    if (slots) return { rowIndex: Number(slots.dataset.rowIndex), index: slotIndex(slots, clientX) };
    if (under?.closest?.('.available-modules')) return { available: true };
    return null;
  }

  // For as long as a drag is running the wheel is ours, and it does what it
  // would do over the same boxes empty-handed — plain scrolls the page, shift
  // slides the row under the cursor sideways. The cursor has not moved, but
  // what is under it has, so the drop bar is aimed again afterwards.
  const wheelOptions = { passive: false, capture: true };

  function onDragWheel(event) {
    if (!dragged.value) return;
    const delta = event.deltaY || event.deltaX;
    if (!delta) return;
    const { x, y } = dragPoint.value;
    const under = document.elementFromPoint?.(x, y);
    const row = event.shiftKey ? under?.closest?.('.rack-row-slots') : null;
    event.preventDefault();
    if (row) row.scrollLeft += delta;
    else window.scrollBy(0, delta);
    aimAt(x, y);
  }

  // A drag left running when the view goes away (a drop that navigates, a
  // route change mid-gesture) would otherwise leave the wheel handler behind.
  onBeforeUnmount(endDrag);

  // Which slot the cursor is aiming at: the first module whose left half it is
  // over, else the end of the row. Measured against the DOM, which still holds
  // the pre-drop order, so the answer is an index into the row as it stands.
  function slotIndex(container, clientX) {
    const slots = [...container.querySelectorAll('.placed-module')];
    for (const [index, slot] of slots.entries()) {
      const box = slot.getBoundingClientRect();
      if (clientX < box.left + box.width / 2) return index;
    }
    return slots.length;
  }

  // Putting the module down. The gesture ends either way: a drop that lands on
  // nothing simply leaves the layout as it was.
  async function finishDrag(hint) {
    const held = dragged.value;
    endDrag();
    if (!held || !organizer.value) return;
    if (hint?.available) await dropIntoAvailable(held);
    else if (Number.isInteger(hint?.rowIndex)) await dropIntoRow(held, hint.rowIndex, hint.index);
  }

  async function dropIntoRow(held, rowIndex, index) {
    const row = organizer.value.rows[rowIndex];
    if (!row) return;
    let target = index;
    if (held.rowIndex !== null) {
      // Pulling the module out shifts everything to its right one slot left, so
      // a target beyond it means one less by the time it is put back down.
      if (held.rowIndex === rowIndex && held.index < target) target -= 1;
      if (held.rowIndex === rowIndex && held.index === target) return;
      organizer.value.rows[held.rowIndex].modules.splice(held.index, 1);
    }
    if (rowUsed(row) + (Number(held.module.hp) || 0) > Number(row.hp)) {
      if (held.rowIndex !== null) organizer.value.rows[held.rowIndex].modules.splice(held.index, 0, held.module);
      refuse(
        `${held.module.manufacturer} ${held.module.name} (${held.module.hp}HP) does not fit in this ${row.hp}HP row — ` +
          `${rowUsed(row)}HP of it is used.`
      );
      return;
    }
    row.modules.splice(target, 0, held.module);
    await saveLayout();
  }

  async function dropIntoAvailable(held) {
    if (held.rowIndex === null) return;
    organizer.value.rows[held.rowIndex].modules.splice(held.index, 1);
    await saveLayout();
  }

  return { dragPoint, onModuleMouseDown, endDrag, dropIntoRow };
}
