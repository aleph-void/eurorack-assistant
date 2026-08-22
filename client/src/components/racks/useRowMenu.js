// Placing a module without dragging it.
//
// Alt-click (or right-click) on an available module opens a menu of the
// rack's rows: on a tall case the row a module belongs in is usually scrolled
// off the screen the chip is on, and a drag cannot be aimed at a box that is
// not in view. Held at the cursor in client coordinates, like the drag ghost.
//
// Split out of RacksView.vue, which is otherwise the organizer itself.

import { nextTick, onBeforeUnmount, ref } from 'vue';

// `rowUsed` is how much of a row is already taken, which is the whole of what
// the menu has to say about each row: whether this module fits in it.
export function useRowMenu({ rowUsed }) {
  // Alt-click (or right-click) on an available module opens a menu of the
  // rack's rows, so a module can be placed without dragging it: on a tall case
  // the row it belongs in is usually scrolled off the screen the chip is on,
  // and a drag cannot be aimed at a box that is not in view. Held at the
  // cursor in client coordinates, like the drag ghost. The module goes on the
  // END of the row it is sent to — that is what the list can say; where in the
  // row it sits is still a drag or an arrow key.
  const rowMenu = ref(null);
  const rowMenuEl = ref(null);
  const MENU_MARGIN = 8;

  const fitsInRow = (row, module) =>
    rowUsed(row) + (Number(module?.hp) || 0) <= Number(row.hp);

  function rowMenuHint(row, module) {
    if (fitsInRow(row, module)) return `Add to row ${row.unit}U, ${Number(row.hp) - rowUsed(row)}HP free`;
    return `No room — ${module.hp || 0}HP needed, ${Math.max(0, Number(row.hp) - rowUsed(row))}HP free`;
  }

  async function openRowMenu(module, event) {
    rowMenu.value = { module, x: event.clientX, y: event.clientY };
    window.addEventListener('mousedown', onRowMenuOutside, true);
    window.addEventListener('keydown', onRowMenuKey, true);
    window.addEventListener('scroll', closeRowMenu, true);
    await nextTick();
    const menu = rowMenuEl.value;
    if (!(menu instanceof HTMLElement) || !rowMenu.value) return;
    // A chip near the right or bottom edge would otherwise open a menu half
    // off the screen. jsdom measures everything as zero, which clamps to the
    // margin and changes nothing about which rows are listed.
    const box = menu.getBoundingClientRect();
    rowMenu.value = {
      ...rowMenu.value,
      x: Math.max(MENU_MARGIN, Math.min(rowMenu.value.x, window.innerWidth - box.width - MENU_MARGIN)),
      y: Math.max(MENU_MARGIN, Math.min(rowMenu.value.y, window.innerHeight - box.height - MENU_MARGIN)),
    };
    const first = menu.querySelector('button:not([disabled])');
    if (first instanceof HTMLElement) first.focus();
  }

  function closeRowMenu() {
    rowMenu.value = null;
    window.removeEventListener('mousedown', onRowMenuOutside, true);
    window.removeEventListener('keydown', onRowMenuKey, true);
    window.removeEventListener('scroll', closeRowMenu, true);
  }

  // A press anywhere else — including the chip that opened it, or another one —
  // puts the menu away before that press does whatever it does.
  function onRowMenuOutside(event) {
    if (event.target instanceof Node && rowMenuEl.value?.contains(event.target)) return;
    closeRowMenu();
  }

  function onRowMenuKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeRowMenu();
  }

  onBeforeUnmount(closeRowMenu);

  return { rowMenu, rowMenuEl, fitsInRow, rowMenuHint, openRowMenu, closeRowMenu };
}
