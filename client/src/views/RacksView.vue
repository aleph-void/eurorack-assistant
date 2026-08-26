<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ComponentLegend from '../components/ComponentLegend.vue';
import ShareButton from '../components/ShareButton.vue';
import ResourceLinks from '../components/ResourceLinks.vue';
import { panelCropStyle } from '../panelLayout.js';
import { usePanelChips } from '../components/racks/usePanelChips.js';
import { useRackDrag } from '../components/racks/useRackDrag.js';
import { useRowMenu } from '../components/racks/useRowMenu.js';
import { toast } from '../toast.js';
import { refreshRackModules } from '../components/moduledetail/useModuleRecord.js';

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
// Which rack's links are open, if any. A rack has no page of its own, so the
// links it keeps — the build thread, the case's manual — are a panel opened
// from its row, the way the organizer is.
const linksRackId = ref(null);
const linksRack = computed(() => racks.value.find((r) => r.id === linksRackId.value) ?? null);
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
    // A rack takes the modules only it held with it, so the list the module
    // pages keep for the session is out of date now.
    refreshRackModules();
  } catch (e) {
    error.value = e.message;
  }
}

async function openOrganizer(rack) {
  closeRowMenu();
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
    openedRows.value = (organizer.value.rows || []).map(() => false);
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
// …and whether it has EVER been open. A collapsed row is only hidden by the
// browser: every panel in it is still built, laid out and — because a hidden
// <img> is still fetched — downloaded. A rack of two hundred modules opened
// its organizer by pulling two hundred panel pictures for rows nobody had
// unfolded. So a row's strip is built the first time it is opened and kept
// from then on, which is the rule the rest of the app follows for a section
// that starts closed (`lazyPanel.js`).
const openedRows = ref([]);
const rowOpened = (rowIndex) => openedRows.value[rowIndex] === true;
function toggleRowCollapsed(rowIndex) {
  const next = collapsedRows.value.slice();
  next[rowIndex] = !next[rowIndex];
  collapsedRows.value = next;
  if (!next[rowIndex] && !openedRows.value[rowIndex]) {
    const seen = openedRows.value.slice();
    seen[rowIndex] = true;
    openedRows.value = seen;
  }
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


// The jacks and controls marked on each panel in the rows, in the colours
// every other picture of a panel uses (componentTypes.js) — so a rack being
// built can be read as hardware and not just as blocks of the right width.
const { showMarkers, CHIP_SCALE, panelUrl, panelMarkers } = usePanelChips();

// The key under the rows: every type placed on a panel of this rack.
const placedComponents = computed(() =>
  (organizer.value?.rows || []).flatMap((row) =>
    (row.modules || []).flatMap((module) => module.panel?.components ?? [])
  )
);

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
  // A row added was asked for to be filled, so it starts open — and therefore
  // starts built.
  openedRows.value = [...openedRows.value, true];
  await saveLayout();
}

async function removeRow(index) {
  organizer.value.rows.splice(index, 1);
  const flags = collapsedRows.value.slice();
  flags.splice(index, 1);
  collapsedRows.value = flags;
  const seen = openedRows.value.slice();
  seen.splice(index, 1);
  openedRows.value = seen;
  await saveLayout();
}

// The organizer's drag is done with plain mouse events, NOT the HTML5
// drag-and-drop API. A native drag is a modal gesture that swallows the
// wheel: the browser dispatches no wheel event to the page at all while a
// drag is running, so no amount of listening gets a row further down into
// reach without dropping the module first. Following the mouse ourselves
// keeps the wheel an ordinary event for the length of the gesture.

// Dragging a module into, along and out of a row.
const { dragPoint, onModuleMouseDown, dropIntoRow } = useRackDrag({
  organizer,
  dragged,
  dropHint,
  rowUsed,
  refuse,
  saveLayout,
});

// …and placing one without dragging it, for the row that is scrolled off the
// screen the chip is on.
const { rowMenu, rowMenuEl, fitsInRow, rowMenuHint, openRowMenu, closeRowMenu } = useRowMenu({
  rowUsed,
});


// Sending the module to the end of the chosen row is the same move as a drop
// there, so it goes through the same code: the HP check, the refusal and the
// save are all one path.
async function placeInRow(rowIndex) {
  const module = rowMenu.value?.module;
  closeRowMenu();
  const row = organizer.value?.rows[rowIndex];
  if (!module || !row) return;
  const held = {
    // Inventory entries use `id`, row placements `module_id` — normalized
    // here for the same reason a drag normalizes it as it starts.
    module: { ...module, module_id: module.module_id ?? module.id },
    rowIndex: null,
    index: null,
  };
  await dropIntoRow(held, rowIndex, row.modules.length);
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
            <td data-label="Name">
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
            <td data-label="Modules">{{ rack.module_count }}</td>
            <td data-label="System">
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
            <td data-label="Layout">
              <div class="actions nowrap">
                <button
                  class="secondary"
                  style="margin: 0"
                  :data-test="`organize-${rack.id}`"
                  @click="openOrganizer(rack)"
                >
                  {{ organizingRackId === rack.id ? 'Close organizer' : 'Organize rack' }}
                </button>
                <button
                  class="secondary"
                  style="margin: 0"
                  :data-test="`links-${rack.id}`"
                  @click="linksRackId = linksRackId === rack.id ? null : rack.id"
                >
                  {{ linksRackId === rack.id ? 'Close links' : 'Links' }}
                </button>
              </div>
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

    <section v-if="linksRack" class="rack-links" data-test="rack-links">
      <h2>{{ linksRack.name }}</h2>
      <ResourceLinks kind="rack" :record-id="linksRack.id" />
    </section>

    <section v-if="organizer" class="rack-organizer" data-test="rack-organizer">
      <h2>Organize {{ organizer.name }}</h2>
      <p class="muted">
        Add 3U and 1U rows, set their HP, then drag each module copy into its physical row — or
        alt-click (or right-click) an available module to send it to the end of a row you choose,
        which beats dragging when the row is scrolled out of sight. Drop a module between two
        others to place it there — that is how a row is reordered — or focus one and press
        <kbd>←</kbd>/<kbd>→</kbd> to step it along. A row cannot exceed its HP capacity.
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
            :title="`${module.manufacturer} ${module.name} — drag into a row, or alt- or right-click to pick one`"
            :style="{ '--module-hp': Math.max(2, Number(module.hp) || 4) }"
            @mousedown="onModuleMouseDown(module, null, null, 3, $event)"
            @click.alt.prevent="openRowMenu(module, $event)"
            @contextmenu.prevent="openRowMenu(module, $event)"
          >
            <span class="module-panel-thumb" :class="{ 'thumb-fallback': !module.panel }">
              <img
                v-if="module.panel"
                :src="panelUrl(module, CHIP_SCALE)"
                :style="panelCropStyle(module.panel)"
                :alt="`${module.manufacturer} ${module.name}`"
                loading="lazy"
                decoding="async"
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
        <label class="inline-check" style="margin-left: auto">
          <input v-model="showMarkers" type="checkbox" data-test="show-markers" />
          Mark jacks and controls
        </label>
      </div>
      <ComponentLegend v-if="showMarkers" :items="placedComponents" />

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
          v-if="rowOpened(rowIndex)"
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
              :src="panelUrl(module)"
              :style="panelCropStyle(module.panel)"
              :alt="`${module.manufacturer} ${module.name}`"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="panel-fallback">{{ module.manufacturer }}<br />{{ module.name }}<br />{{ module.hp }}HP</span>
            <!-- Each marker sits at its fraction of the FRONT PLATE, which is
                 exactly the box the cropped picture fills. -->
            <span
              v-for="marker in panelMarkers(module.panel)"
              :key="marker.key"
              class="panel-marker"
              :style="{ left: `${marker.fx * 100}%`, top: `${marker.fy * 100}%`, background: marker.color }"
              :title="marker.name"
            ></span>
          </button>
          <span v-if="row.modules.length === 0" class="muted">Drop modules here</span>
        </div>
      </div>

      <!-- Which row to send an available module to. Above the topbar for the
           same reason the drag ghost is: a chip near the top of the window
           would otherwise open its menu under the menu bar. -->
      <div
        v-if="rowMenu"
        ref="rowMenuEl"
        class="row-menu"
        role="menu"
        data-test="row-menu"
        :style="{ left: `${rowMenu.x}px`, top: `${rowMenu.y}px` }"
      >
        <p class="row-menu-head">
          Add {{ rowMenu.module.manufacturer }} {{ rowMenu.module.name }}
          <em>{{ rowMenu.module.hp ? `${rowMenu.module.hp}HP` : 'HP unknown' }}</em> to
        </p>
        <p v-if="organizer.rows.length === 0" class="muted" data-test="row-menu-empty">
          No rows yet — add a 3U or 1U row first.
        </p>
        <button
          v-for="(row, rowIndex) in organizer.rows"
          :key="rowIndex"
          type="button"
          role="menuitem"
          class="row-menu-item"
          :disabled="!fitsInRow(row, rowMenu.module)"
          :title="rowMenuHint(row, rowMenu.module)"
          :data-test="`row-menu-${rowIndex}`"
          @click="placeInRow(rowIndex)"
        >
          Row {{ rowIndex + 1 }}
          <span class="muted">{{ row.unit }}U · {{ rowUsed(row) }}/{{ row.hp }}HP</span>
        </button>
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
          :src="panelUrl(dragged.module)"
          :style="panelCropStyle(dragged.module.panel)"
          alt=""
          decoding="async"
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
/* A jack or control marked on the panel it sits on, in its type's colour.
   Small enough that a 2HP module is still readable, and dark-ringed so a pale
   marker holds its edge on a pale plate. */
.panel-marker { position: absolute; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(9, 9, 11, 0.85); pointer-events: none; }
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
.row-menu { position: fixed; z-index: 65; min-width: 12rem; max-height: 60vh; overflow-y: auto; padding: 0.4rem; background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 7px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
.row-menu-head { margin: 0.1rem 0.3rem 0.4rem; font-size: 0.75rem; color: var(--muted); }
.row-menu-head em { font-style: normal; color: var(--faint); }
.row-menu-item { display: flex; justify-content: space-between; gap: 0.8rem; width: 100%; margin: 0 0 0.2rem; padding: 0.35rem 0.5rem; background: transparent; border: 1px solid transparent; color: var(--text); font-size: 0.8rem; text-align: left; }
.row-menu-item:hover:not(:disabled), .row-menu-item:focus-visible { border-color: var(--accent); background: var(--accent-glow); }
</style>
