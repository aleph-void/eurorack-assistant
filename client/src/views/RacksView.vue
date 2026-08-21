<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ShareButton from '../components/ShareButton.vue';
import { panelCropStyle, panelThumbUrl } from '../panelLayout.js';
import { toast } from '../toast.js';

const racks = ref([]);
const systems = ref([]);
const error = ref('');
const notice = ref('');
const loading = ref(true);
const newName = ref('');
const renamingId = ref(null);
const renameValue = ref('');
const organizer = ref(null);
const organizingRackId = ref(null);
const layoutBusy = ref(false);
const dragged = ref(null);
// A layout failure is shown INSIDE the organizer: `error` is drawn at the top
// of the page, far above a mega rack's rows, where a refused save reads as a
// button that did nothing.
const layoutError = ref('');
// Where the module in hand would land: { rowIndex, index }. Drawn as a bar on
// the slot edge the drop would insert against, so a reorder can be aimed.
const dropHint = ref(null);

async function load() {
  try {
    [racks.value, systems.value] = await Promise.all([
      api.get('/api/racks'),
      api.get('/api/systems'),
    ]);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function create() {
  error.value = '';
  try {
    await api.post('/api/racks', { name: newName.value });
    newName.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function startRename(rack) {
  renamingId.value = rack.id;
  renameValue.value = rack.name;
}

async function rename(rack) {
  error.value = '';
  try {
    await api.put(`/api/racks/${rack.id}`, { name: renameValue.value });
    renamingId.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);

// Put a rack into one of the user's systems, or take it out of the one it is
// in. Racks keep their modules and their own row layout either way — the
// system only says which racks are patched together.
async function setSystem(rack, event) {
  const value = event.target.value;
  error.value = '';
  try {
    await api.put(`/api/racks/${rack.id}/system`, { system_id: value === '' ? null : Number(value) });
    await load();
  } catch (e) {
    error.value = e.message;
    await load();
  }
}

// The zip is built by a background job; when its 'completed' event arrives
// over the WebSocket the jobs store starts the download automatically.
async function exportRack(rack) {
  error.value = '';
  notice.value = '';
  try {
    await api.post(`/api/racks/${rack.id}/export`);
    notice.value =
      `Export of '${rack.name}' queued — the zip downloads automatically when it is ready ` +
      '(progress is on the Jobs page).';
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(rack) {
  const ok = await dialog.confirm({
    title: 'Delete rack',
    message:
      `Delete rack '${rack.name}' and its ${rack.module_count} module(s)? ` +
      'The modules themselves stay on the server with their manuals, ' +
      'analysis and panels, so importing them again restores that work.',
    confirmLabel: 'Delete rack',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/racks/${rack.id}`);
    racks.value = racks.value.filter((r) => r.id !== rack.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function openOrganizer(rack) {
  if (organizingRackId.value === rack.id) {
    organizingRackId.value = null;
    organizer.value = null;
    return;
  }
  error.value = '';
  try {
    organizer.value = await api.get(`/api/racks/${rack.id}`);
    organizingRackId.value = rack.id;
    // Every row starts folded: a full case is several rows of panels tall,
    // and opening the organizer on all of them buries the controls.
    collapsedRows.value = (organizer.value.rows || []).map(() => true);
    layoutError.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

// Folding a row's panel strip away, so a tall rack's organizer fits on
// screen while one row is being worked on. Every row is folded when the
// organizer opens; a row added afterwards starts open, since it was asked
// for to be filled. Pure view state: the layout is untouched, and the strip
// stays in the DOM (v-show) like every other collapsed section in the app.
// Held BY POSITION, one flag per row: saving
// the layout REPLACES the rack's rows (PUT /:id/layout deletes and
// re-inserts them), so a row's id is a different number after every drop and
// cannot identify the same row across a save. The flags are spliced along
// with the rows when one is removed.
const collapsedRows = ref([]);
const rowCollapsed = (rowIndex) => collapsedRows.value[rowIndex] === true;
function toggleRowCollapsed(rowIndex) {
  const next = collapsedRows.value.slice();
  next[rowIndex] = !next[rowIndex];
  collapsedRows.value = next;
}

const placedCounts = computed(() => {
  const counts = new Map();
  for (const row of organizer.value?.rows || []) {
    for (const module of row.modules || []) counts.set(module.module_id, (counts.get(module.module_id) || 0) + 1);
  }
  return counts;
});
const availableModules = computed(() =>
  (organizer.value?.modules || []).flatMap((module) =>
    Array.from({ length: Math.max(0, module.quantity - (placedCounts.value.get(module.id) || 0)) }, () => module)
  )
);
// Placements the rack cannot back: a module put in the rows more often than
// the rack holds it. The server refuses a layout like that outright, so a rack
// that has somehow ACQUIRED one — duplicated rows, from two saves racing —
// cannot save any edit at all until the extra placements are gone. Naming the
// module that is over-placed, without spending a round trip to be told, is
// what makes such a rack fixable from the organizer.
const overPlaced = computed(() => {
  const inventory = new Map((organizer.value?.modules || []).map((module) => [module.id, module.quantity]));
  return [...placedCounts.value.entries()]
    .filter(([id, count]) => count > (inventory.get(id) ?? 0))
    .map(([id, count]) => {
      const module = (organizer.value?.modules || []).find((entry) => entry.id === id);
      const name = module ? `${module.manufacturer} ${module.name}` : `module ${id}`;
      return `${name} (${count} placed, ${inventory.get(id) ?? 0} in the rack)`;
    });
});

const DEFAULT_ROW_HP = 104;
const rowUsed = (row) => (row.modules || []).reduce((sum, module) => sum + (Number(module.hp) || 0), 0);

// A save REPLACES the rack's rows — the server deletes them and writes the
// ones it was sent — so two saves in flight at once are a race the rack loses:
// each one deletes the rows it can see and then inserts its own, and the rack
// is left holding both sets. That is where duplicated rows come from, and a
// held arrow key or a flurry of drops is enough to cause it. Only ever one
// save is in the air; a save asked for while one is running is remembered and
// made when it lands, from whatever the layout says by then. (The server takes
// the rack for the length of the write as well now, but the organizer should
// not be leaning on that.)
let saving = null;
let saveAgain = false;

function saveLayout() {
  if (!organizer.value) return Promise.resolve();
  if (saving) {
    saveAgain = true;
    return saving;
  }
  saving = (async () => {
    layoutBusy.value = true;
    try {
      do {
        saveAgain = false;
        await putLayout();
      } while (saveAgain);
    } finally {
      saving = null;
      saveAgain = false;
      layoutBusy.value = false;
    }
  })();
  return saving;
}

// A refused layout is said twice: in the panel beside the rows, and as a
// toast, because the organizer is a long page and the panel is easy to be
// scrolled away from — a drop refused for want of HP looked for all the world
// like a drop that simply did not work.
function refuse(message) {
  layoutError.value = message;
  toast.error(message, { title: 'Layout not saved' });
}

async function putLayout() {
  layoutError.value = '';
  if (overPlaced.value.length) {
    refuse(
      `Not saved — ${overPlaced.value.join('; ')}. ` +
        'Remove the extra placements (duplicated rows are the usual cause) and the layout saves itself.'
    );
    return;
  }
  try {
    const result = await api.put(`/api/racks/${organizer.value.id}/layout`, {
      rows: organizer.value.rows.map((row) => ({
        unit: Number(row.unit),
        hp: Number(row.hp),
        modules: row.modules.map((module) => ({ module_id: module.module_id })),
      })),
    });
    organizer.value = { ...organizer.value, rows: result.rows };
  } catch (e) {
    // The rows on screen are what the user asked for, so they STAY on screen
    // when the server refuses them. Reloading the stored layout instead used
    // to undo the edit as well, which is what made a rack whose stored layout
    // is already invalid impossible to repair: every removal was reverted by
    // the failure it was meant to fix.
    refuse(`${e.message} — the rows on screen are not saved.`);
  }
}

// A new row is another row of the same case, so it starts at the width the
// rack is already built to. Rows that disagree say nothing about what the
// next one should be, and nor does a rack with no rows yet.
function nextRowHp() {
  const widths = new Set(
    (organizer.value?.rows || []).map((row) => Number(row.hp)).filter((hp) => hp > 0)
  );
  return widths.size === 1 ? [...widths][0] : DEFAULT_ROW_HP;
}

async function addRow(unit) {
  organizer.value.rows.push({ unit, hp: nextRowHp(), modules: [] });
  await saveLayout();
}

async function removeRow(index) {
  organizer.value.rows.splice(index, 1);
  const flags = collapsedRows.value.slice();
  flags.splice(index, 1);
  collapsedRows.value = flags;
  await saveLayout();
}

// The organizer's drag is done with plain mouse events, NOT the HTML5
// drag-and-drop API. A native drag is a modal gesture that swallows the
// wheel: the browser dispatches no wheel event to the page at all while a
// drag is running, so no amount of listening gets a row further down into
// reach without dropping the module first. Following the mouse ourselves
// keeps the wheel an ordinary event for the length of the gesture.
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
  aimAt(event.clientX, event.clientY);
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

// Alt-click (or right-click) pulls the module straight off the row and back
// into the available list — the same move as dragging it out to Available,
// without having to land a drag with a 2HP-wide target in hand.
async function removeFromRow(rowIndex, index) {
  const row = organizer.value?.rows[rowIndex];
  if (!row || !row.modules[index]) return;
  row.modules.splice(index, 1);
  await saveLayout();
}

// Keyboard reordering, for the same job without a mouse: the focused module
// steps one place along its row. A 2HP panel is a small drag target, so this
// is the reliable way to nudge one into place.
async function nudge(rowIndex, index, delta) {
  const row = organizer.value?.rows[rowIndex];
  const target = index + delta;
  if (!row || target < 0 || target >= row.modules.length) return;
  const [module] = row.modules.splice(index, 1);
  row.modules.splice(target, 0, module);
  await saveLayout();
  // Keep the module the user is stepping along under the keyboard.
  await nextTick();
  const moved = document.querySelector(`[data-test="placed-module-${rowIndex}-${target}"]`);
  if (moved instanceof HTMLElement) moved.focus();
}
</script>

<template>
  <h1>Your racks</h1>
  <p class="muted">
    Racks group the modules in your systems. Deleting a rack deletes the modules in it — a module
    survives only if it is still in another rack.
  </p>
  <p class="muted">
    Choose <strong>Organize rack</strong> to arrange its physical 3U and 1U rows. Racks in the same
    <RouterLink to="/systems">system</RouterLink> can be patched to each other. To shift gear
    between racks, tick the modules on the
    <RouterLink to="/modules">Modules</RouterLink> page and move them together.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="notice" class="success" data-test="notice">{{ notice }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="racks.length" class="table-wrap">
      <table data-test="rack-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Modules</th>
            <th>System</th>
            <th>Layout</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rack in racks" :key="rack.id" :data-test="`rack-${rack.id}`">
            <td>
              <template v-if="renamingId === rack.id">
                <form class="actions" @submit.prevent="rename(rack)">
                  <input v-model="renameValue" :data-test="`rename-input-${rack.id}`" />
                  <button type="submit" :data-test="`rename-save-${rack.id}`">Save</button>
                  <button type="button" @click="renamingId = null">Cancel</button>
                </form>
              </template>
              <template v-else>
                <RouterLink :to="{ path: '/modules', query: { rack: rack.id } }">
                  {{ rack.name }}
                </RouterLink>
              </template>
            </td>
            <td>{{ rack.module_count }}</td>
            <td>
              <select
                :value="rack.system_id ?? ''"
                :data-test="`system-${rack.id}`"
                aria-label="System"
                @change="setSystem(rack, $event)"
              >
                <option value="">No system</option>
                <option v-for="system in systems" :key="system.id" :value="system.id">
                  {{ system.name }}
                </option>
              </select>
            </td>
            <td>
              <button
                class="secondary"
                style="margin: 0"
                :data-test="`organize-${rack.id}`"
                @click="openOrganizer(rack)"
              >
                {{ organizingRackId === rack.id ? 'Close organizer' : 'Organize rack' }}
              </button>
            </td>
            <td class="actions-cell">
              <div class="actions nowrap">
                <ShareButton :id="rack.id" type="rack" :label="rack.name" small />
                <button
                  v-if="renamingId !== rack.id"
                  :data-test="`rename-${rack.id}`"
                  @click="startRename(rack)"
                >
                  Rename
                </button>
                <button
                  class="secondary"
                  :disabled="rack.module_count === 0"
                  :data-test="`export-${rack.id}`"
                  @click="exportRack(rack)"
                >
                  Export Rack
                </button>
                <button class="danger" :data-test="`delete-${rack.id}`" @click="remove(rack)">
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted">
      No racks yet. <RouterLink to="/import">Import your module list</RouterLink> to create one.
    </p>

    <form @submit.prevent="create">
      <label for="new-rack">New rack</label>
      <div class="row">
        <input id="new-rack" v-model="newName" data-test="new-rack" placeholder="e.g. travel case" />
        <div class="shrink">
          <button type="submit" style="margin: 0" :disabled="!newName.trim()" data-test="create">
            Create
          </button>
        </div>
      </div>
    </form>

    <section v-if="organizer" class="rack-organizer" data-test="rack-organizer">
      <h2>Organize {{ organizer.name }}</h2>
      <p class="muted">
        Add 3U and 1U rows, set their HP, then drag each module copy into its physical row. Drop a
        module between two others to place it there — that is how a row is reordered — or focus one
        and press <kbd>←</kbd>/<kbd>→</kbd> to step it along. A row cannot exceed its HP capacity.
        The wheel still scrolls the page with a module in hand — hold <kbd>Shift</kbd> to slide a row
        wider than its box along — and <kbd>Esc</kbd> puts the module back where it was.
      </p>
      <div
        class="available-modules"
        :class="{ 'drop-target': dropHint?.available && dragged?.rowIndex !== null }"
        data-test="available-modules"
      >
        <h3>Available modules</h3>
        <p v-if="availableModules.length === 0" class="muted">Every module copy is placed.</p>
        <div v-else class="module-chips">
          <button
            v-for="(module, index) in availableModules"
            :key="`${module.id}-${index}`"
            class="module-chip"
            type="button"
            :data-test="`available-module-${module.id}-${index}`"
            :style="{ '--module-hp': Math.max(2, Number(module.hp) || 4) }"
            @mousedown="onModuleMouseDown(module, null, null, 3, $event)"
          >
            <span class="module-panel-thumb" :class="{ 'thumb-fallback': !module.panel }">
              <img
                v-if="module.panel"
                :src="panelThumbUrl(module.panel, 512)"
                :style="panelCropStyle(module.panel)"
                :alt="`${module.manufacturer} ${module.name}`"
              />
            </span>
            <span>{{ module.manufacturer }} {{ module.name }} <em>{{ module.hp ? `${module.hp}HP` : 'HP unknown' }}</em></span>
          </button>
        </div>
      </div>

      <p v-if="layoutError" class="error" data-test="layout-error">
        {{ layoutError }}
        <button class="secondary" style="margin: 0 0 0 0.5rem" data-test="retry-save" @click="saveLayout">
          Retry save
        </button>
      </p>

      <div class="actions spaced">
        <button class="secondary" :disabled="layoutBusy" data-test="add-3u-row" @click="addRow(3)">Add 3U row</button>
        <button class="secondary" :disabled="layoutBusy" data-test="add-1u-row" @click="addRow(1)">Add 1U row</button>
      </div>

      <!-- Keyed by position, not by row id: a save replaces the rows, so
           keying by id would tear down and rebuild every row (and reload its
           panel pictures) after every drop. -->
      <div v-for="(row, rowIndex) in organizer.rows" :key="rowIndex" class="rack-row" :data-test="`rack-row-${rowIndex}`">
        <div class="rack-row-meta">
          <button
            type="button"
            class="row-collapse"
            :aria-expanded="String(!rowCollapsed(rowIndex))"
            :title="rowCollapsed(rowIndex) ? 'Expand row' : 'Collapse row'"
            :data-test="`row-collapse-${rowIndex}`"
            @click="toggleRowCollapsed(rowIndex)"
          >
            {{ rowCollapsed(rowIndex) ? '▸' : '▾' }}
          </button>
          <label>Unit
            <select v-model.number="row.unit" :disabled="layoutBusy" @change="saveLayout">
              <option :value="3">3U</option>
              <option :value="1">1U</option>
            </select>
          </label>
          <label>HP
            <input v-model.number="row.hp" type="number" min="1" max="504" :disabled="layoutBusy" @change="saveLayout" />
          </label>
          <span class="muted" :class="{ 'over-capacity': rowUsed(row) > Number(row.hp) }">
            {{ rowUsed(row) }} / {{ row.hp }}HP
          </span>
          <button
            class="danger"
            style="margin: 0 0 0 auto"
            :disabled="layoutBusy"
            :data-test="`remove-row-${rowIndex}`"
            @click="removeRow(rowIndex)"
          >
            Remove row
          </button>
        </div>
        <div
          v-show="!rowCollapsed(rowIndex)"
          class="rack-row-slots"
          :class="`unit-${row.unit}`"
          :data-row-index="rowIndex"
          :style="{ '--row-units': Number(row.unit) || 3 }"
        >
          <button
            v-for="(module, index) in row.modules"
            :key="`${module.module_id}-${index}`"
            class="placed-module"
            :class="{
              'drop-before': dropHint?.rowIndex === rowIndex && dropHint.index === index,
              'drop-after': dropHint?.rowIndex === rowIndex && dropHint.index === row.modules.length && index === row.modules.length - 1,
              'in-hand': dragged?.rowIndex === rowIndex && dragged.index === index,
            }"
            type="button"
            :title="`${module.manufacturer} ${module.name} — ${module.hp}HP (drag or ← → to reorder, alt- or right-click to remove)`"
            :aria-label="`${module.manufacturer} ${module.name}, place ${index + 1} of ${row.modules.length}`"
            :data-test="`placed-module-${rowIndex}-${index}`"
            :style="{ '--module-hp': Math.max(2, Number(module.hp) || 4) }"
            @mousedown="onModuleMouseDown(module, rowIndex, index, row.unit, $event)"
            @keydown.left.prevent="nudge(rowIndex, index, -1)"
            @keydown.right.prevent="nudge(rowIndex, index, 1)"
            @click.alt.prevent="removeFromRow(rowIndex, index)"
            @contextmenu.prevent="removeFromRow(rowIndex, index)"
          >
            <img
              v-if="module.panel"
              :src="panelThumbUrl(module.panel, 512)"
              :style="panelCropStyle(module.panel)"
              :alt="`${module.manufacturer} ${module.name}`"
            />
            <span v-else class="panel-fallback">{{ module.manufacturer }}<br />{{ module.name }}<br />{{ module.hp }}HP</span>
          </button>
          <span v-if="row.modules.length === 0" class="muted">Drop modules here</span>
        </div>
      </div>

      <!-- What is in hand, drawn under the cursor: with no native drag there
           is no browser drag image, and it is pointer-events: none so the box
           it is over is still the box the drop lands in. -->
      <div
        v-if="dragged"
        class="drag-ghost"
        data-test="drag-ghost"
        aria-hidden="true"
        :style="{
          left: `${dragPoint.x}px`,
          top: `${dragPoint.y}px`,
          '--module-hp': Math.max(2, Number(dragged.module.hp) || 4),
          '--row-units': Number(dragged.unit) || 3,
        }"
      >
        <img
          v-if="dragged.module.panel"
          :src="panelThumbUrl(dragged.module.panel, 512)"
          :style="panelCropStyle(dragged.module.panel)"
          alt=""
        />
        <span v-else class="panel-fallback">
          {{ dragged.module.manufacturer }}<br />{{ dragged.module.name }}<br />{{ dragged.module.hp }}HP
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Every module in the organizer is drawn from ONE scale, so a 2HP module and
   a 34HP one are the same picture at different widths. A rack unit is
   44.45mm and an HP is 5.08mm, so a row is 8.75 HP-widths tall per U —
   panels then keep their real proportions instead of being stretched to
   whatever height the row happened to have. */
.rack-organizer { --hp-px: 9px; --u-px: calc(8.75 * var(--hp-px)); --chip-scale: 0.42; }
.rack-organizer { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem; }
.available-modules { min-height: 3.5rem; border: 1px dashed var(--border-strong); border-radius: 7px; padding: 0.6rem; }
.available-modules { margin: 1rem 0; }
/* Where a module pulled off a row would land if it were dropped now. */
.available-modules.drop-target { border-color: var(--accent); background: #1b1b24; }
.module-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.module-chip { margin: 0; cursor: grab; text-align: center; display: inline-flex; flex-direction: column; align-items: center; gap: 0.25rem; padding: 0.3rem; }
.module-chip span { color: var(--muted); }
/* Buttons are nowrap by default (style.css), which a chip's name must not
   be: it would run out of the available-modules box instead of wrapping. */
.module-chip > span:last-child { max-width: 8rem; font-size: 0.7rem; line-height: 1.2; white-space: normal; overflow-wrap: anywhere; }
.module-chip em { font-style: normal; }
/* The same 3U panel, drawn small: HP across, one rack unit's worth of height
   per U, so the chips line up like the row they are dragged into. */
.module-panel-thumb { position: relative; display: block; flex: none; overflow: hidden; width: calc(var(--module-hp) * var(--hp-px) * var(--chip-scale)); min-width: 10px; height: calc(3 * var(--u-px) * var(--chip-scale)); background: #25252d; }
.module-panel-thumb img { position: absolute; object-fit: fill; }
.thumb-fallback { border: 1px dashed var(--border-strong); }
.rack-row-slots { display: flex; align-items: stretch; gap: 2px; overflow-x: auto; padding: 0.35rem; background: #15151b; border: 2px solid var(--border-strong); border-radius: 5px; height: calc(var(--row-units, 3) * var(--u-px)); }
.placed-module { flex: 0 0 calc(var(--module-hp) * var(--hp-px)); width: calc(var(--module-hp) * var(--hp-px)); height: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; cursor: grab; overflow: hidden; background: #25252d; }
.placed-module { position: relative; }
/* Where a drop would land, drawn INSIDE the slot it inserts against: a bar
   between two panels would push the row along mid-drag and move the very
   target being aimed at. */
.placed-module.drop-before { box-shadow: inset 3px 0 0 var(--accent); }
/* The slot a module was picked up from, left in place so the row does not
   close up and move the very targets being aimed at. */
.placed-module.in-hand { opacity: 0.3; }
.placed-module.drop-after { box-shadow: inset -3px 0 0 var(--accent); }
.placed-module:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
/* The image is sized and offset by the panel's crop (panelLayout.js), so the
   blank backdrop a product photo came with stays outside the box. */
.placed-module img { position: absolute; display: block; object-fit: fill; }
/* A module with no panel picture still occupies its real width, so the name
   is set narrow and clipped rather than widening the box. */
.panel-fallback { display: grid; place-items: center; height: 100%; padding: 0.15rem; font-size: 0.6rem; line-height: 1.15; overflow-wrap: anywhere; text-align: center; color: var(--muted); }
.rack-row { margin: 0.8rem 0; }
.rack-row-meta { display: flex; align-items: end; gap: 0.7rem; margin-bottom: 0.35rem; }
.rack-row-meta label { display: grid; gap: 0.15rem; font-size: 0.85rem; }
.rack-row-meta input, .rack-row-meta select { width: 6rem; margin: 0; }
/* A row can go over capacity without anyone dragging anything — a supplied
   panel measures its module wider — and the layout will not save until it is
   under again, so the row that has to give says so. */
.rack-row-meta .over-capacity { color: var(--danger); }
/* Drawn at the same scale as the row it is headed for, so what is in hand
   is the size it will be when it lands. */
/* Above the sticky topbar (z-index 60), so a module dragged to the top of
   the window is not slid under the menu bar. */
.drag-ghost { position: fixed; z-index: 65; pointer-events: none; transform: translate(-50%, -50%); }
.drag-ghost { width: calc(var(--module-hp) * var(--hp-px)); height: calc(var(--row-units) * var(--u-px)); }
.drag-ghost { overflow: hidden; background: #25252d; border: 1px solid var(--accent); opacity: 0.85; }
.drag-ghost img { position: absolute; display: block; object-fit: fill; }
.row-collapse { margin: 0; padding: 0.15rem 0.5rem; background: transparent; border: 1px solid var(--border-strong); color: var(--muted); }
</style>
