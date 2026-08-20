<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { panelCropStyle } from '../panelLayout.js';

// A system is a group of racks patched together as one instrument. This page
// lists them, assigns racks in and out, and arranges the racks of one system
// on a floor plan so the picture matches the studio.

const systems = ref([]);
const error = ref('');
const notice = ref('');
const loading = ref(true);
const newName = ref('');
const newDescription = ref('');
const renamingId = ref(null);
const renameValue = ref('');

// The system currently open for arranging, as returned by GET /api/systems/:id
const plan = ref(null);
const openId = ref(null);
const planBusy = ref(false);
const dragged = ref(null);

async function load() {
  try {
    systems.value = await api.get('/api/systems');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function create() {
  error.value = '';
  try {
    await api.post('/api/systems', {
      name: newName.value,
      description: newDescription.value.trim() || undefined,
    });
    newName.value = '';
    newDescription.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function startRename(system) {
  renamingId.value = system.id;
  renameValue.value = system.name;
}

async function rename(system) {
  error.value = '';
  try {
    await api.put(`/api/systems/${system.id}`, { name: renameValue.value });
    renamingId.value = null;
    await load();
    if (openId.value === system.id) await openPlan(system, { force: true });
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(system) {
  const ok = await dialog.confirm({
    title: 'Delete system',
    message:
      `Delete system '${system.name}'? Its ${system.rack_count} rack(s) are kept — ` +
      'they simply stop being part of a system, with their modules and layouts intact.',
    confirmLabel: 'Delete system',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/systems/${system.id}`);
    systems.value = systems.value.filter((s) => s.id !== system.id);
    if (openId.value === system.id) {
      openId.value = null;
      plan.value = null;
    }
  } catch (e) {
    error.value = e.message;
  }
}

// Cut the blank backdrop off every panel in the system, in one go. The same
// trim the module page offers, asked for once for the whole studio — which is
// what makes a floor plan drawn from photographs read like real furniture
// rather than a wall of white margins. A system's worth of images is far too
// much to wait on, so the server queues a job and the Jobs page reports it.
//
// Cutting a panel down is not undoable, so it is confirmed first; a panel
// that has already been trimmed is left alone either way.
const trimming = ref(null);
async function trimPanels(system) {
  const ok = await dialog.confirm({
    title: 'Trim all panels',
    message:
      `Trim the panel picture of every module in '${system.name}'? Each image is cut down to ` +
      'the front plate itself and its markers move with it. Panels that are already trimmed ' +
      'are left alone, and the cut cannot be undone.',
    confirmLabel: 'Trim all panels',
  });
  if (!ok) return;
  error.value = '';
  notice.value = '';
  trimming.value = system.id;
  try {
    await api.post(`/api/systems/${system.id}/panels/trim`);
    notice.value =
      `Trimming the panels of '${system.name}' — it runs in the background ` +
      '(progress is on the Jobs page).';
  } catch (e) {
    error.value = e.message;
  } finally {
    trimming.value = null;
  }
}

async function openPlan(system, { force = false } = {}) {
  if (!force && openId.value === system.id) {
    openId.value = null;
    plan.value = null;
    return;
  }
  error.value = '';
  try {
    plan.value = await api.get(`/api/systems/${system.id}`);
    openId.value = system.id;
  } catch (e) {
    error.value = e.message;
  }
}

// ---- the floor plan ----
// A rack's box is drawn to scale: as wide as its widest row in HP and as tall
// as its rows are in rack units, so the plan reads like the real furniture.
// Coordinates are in those same units, which is what the server stores.
// The server sends each rack's footprint with it, so the picture and the
// placement rule it enforces are worked out from the same numbers.
// One HP is 5.08mm and one rack unit 44.45mm, so a rack unit is 8.75 HP-widths
// tall. Drawing at that ratio is what keeps a panel here the same picture it is
// in the rack organizer, rather than a stretched one.
const HP_PX = 4;
const U_PX = HP_PX * 8.75;

// A studio that stands in one long row does not fit on a screen at full
// size, so the plan can be drawn smaller. Zoom only scales the drawing —
// every coordinate stays in HP and rack units.
const zoom = ref(1);
const hpPx = computed(() => HP_PX * zoom.value);
const uPx = computed(() => U_PX * zoom.value);

const rackSize = (rack) => ({
  width: Number(rack.width_hp) || 84,
  height: Number(rack.height_u) || 3,
});
const rackBox = (rack) => ({
  x: Number(rack.system_x) || 0,
  y: Number(rack.system_y) || 0,
  ...rackSize(rack),
});

// Two racks overlap when their boxes share floor in both directions;
// standing flush, edge against edge, is how cases really sit. The server
// enforces the same rule (services/racks.js) — this is what keeps the drag
// from proposing a placement it would refuse.
const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const planRacks = computed(() => plan.value?.racks || []);
const unassigned = computed(() => plan.value?.unassigned_racks || []);

// What the server will accept for a floor (routes/systems.js), and the size
// an in-progress edge drag is drawing at before it is saved.
const MIN_FLOOR_WIDTH = 20;
const MIN_FLOOR_HEIGHT = 3;
const MAX_FLOOR = 5000;
const draftFloor = ref(null);

// The floor the user has made, never smaller than what the racks standing on
// it need — shrinking the plan may not hide a rack.
const planExtent = computed(() => {
  let width = draftFloor.value?.width ?? (Number(plan.value?.floor_width) || 140);
  let height = draftFloor.value?.height ?? (Number(plan.value?.floor_height) || 9);
  for (const rack of planRacks.value) {
    const box = rackBox(rack);
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }
  return { width, height };
});
const planStyle = computed(() => ({
  width: `${planExtent.value.width * hpPx.value}px`,
  height: `${planExtent.value.height * uPx.value}px`,
}));

const rackStyle = (rack) => {
  const box = rackBox(rack);
  return {
    left: `${box.x * hpPx.value}px`,
    top: `${box.y * uPx.value}px`,
    width: `${box.width * hpPx.value}px`,
    height: `${box.height * uPx.value}px`,
  };
};
const rowStyle = (row) => ({ height: `${(Number(row.unit) || 3) * uPx.value}px` });
const moduleStyle = (module) => ({ width: `${(Number(module.hp) || 4) * hpPx.value}px` });

// How much floor there is to arrange on. Saved on the system, because a
// studio's shape is a property of the studio and not of this browser.
const floorBusy = ref(false);
async function resizeFloor(width, height) {
  if (!plan.value) return;
  const floor_width = Math.max(MIN_FLOOR_WIDTH, Math.min(MAX_FLOOR, Math.round(width)));
  const floor_height = Math.max(MIN_FLOOR_HEIGHT, Math.min(MAX_FLOOR, Math.round(height)));
  floorBusy.value = true;
  error.value = '';
  try {
    const saved = await api.put(`/api/systems/${plan.value.id}`, { floor_width, floor_height });
    plan.value = { ...plan.value, floor_width: saved.floor_width, floor_height: saved.floor_height };
  } catch (e) {
    error.value = e.message;
  } finally {
    floorBusy.value = false;
  }
}
// Dragging the floor's own edge is how the plan is made bigger: grab the
// right edge, the bottom edge or the corner and pull. The drag itself only
// moves a draft size (so the floor grows under the pointer without a request
// per pixel); letting go saves it. The draft never goes below the minimum,
// and planExtent still keeps the floor at least as big as the racks need.
const resizing = ref(null);

function startResize(edge, event) {
  if (!plan.value || floorBusy.value) return;
  event.preventDefault();
  // The drag starts from the size the floor is DRAWN at, so the edge follows
  // the pointer from where it was grabbed even when racks have pushed the
  // floor past the stored size. The axis not being dragged keeps the stored
  // size instead, so pulling the bottom edge never quietly saves a new width.
  resizing.value = {
    edge,
    x: event.clientX,
    y: event.clientY,
    width: planExtent.value.width,
    height: planExtent.value.height,
    keepWidth: Number(plan.value.floor_width) || 140,
    keepHeight: Number(plan.value.floor_height) || 9,
  };
  draftFloor.value = { width: planExtent.value.width, height: planExtent.value.height };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveResize(event) {
  const held = resizing.value;
  if (!held) return;
  const clamp = (value, min) => Math.max(min, Math.min(MAX_FLOOR, Math.round(value)));
  draftFloor.value = {
    width: held.edge === 'bottom'
      ? held.width
      : clamp(held.width + (event.clientX - held.x) / hpPx.value, MIN_FLOOR_WIDTH),
    height: held.edge === 'right'
      ? held.height
      : clamp(held.height + (event.clientY - held.y) / uPx.value, MIN_FLOOR_HEIGHT),
  };
}

async function endResize(event) {
  if (!resizing.value) return;
  moveResize(event);
  const held = resizing.value;
  const draft = draftFloor.value;
  resizing.value = null;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  // Keep the drawn size until the save comes back, so the floor does not
  // snap back to its old size for a frame.
  try {
    await resizeFloor(
      held.edge === 'bottom' ? held.keepWidth : draft.width,
      held.edge === 'right' ? held.keepHeight : draft.height
    );
  } finally {
    draftFloor.value = null;
  }
}

async function saveArrangement() {
  if (!plan.value) return;
  planBusy.value = true;
  error.value = '';
  try {
    await api.put(`/api/systems/${plan.value.id}/layout`, {
      racks: planRacks.value.map((rack) => ({
        rack_id: rack.id,
        x: Number(rack.system_x) || 0,
        y: Number(rack.system_y) || 0,
      })),
    });
  } catch (e) {
    error.value = e.message;
    plan.value = await api.get(`/api/systems/${plan.value.id}`);
  } finally {
    planBusy.value = false;
  }
}

// Dragging a rack across the plan. The offset within the box is kept so the
// rack does not jump to put its corner under the pointer.
function startPlanDrag(rack, event) {
  const box = event.currentTarget.getBoundingClientRect();
  dragged.value = {
    rack_id: rack.id,
    dx: (event.clientX - box.left) / hpPx.value,
    dy: (event.clientY - box.top) / uPx.value,
  };
}

// Where a rack dropped at (x, y) actually comes to rest. Racks may not stand
// on top of each other, so a box that lands on a neighbour is pushed clear of
// it the short way — which is what makes standing two cases flush together a
// matter of dropping roughly right rather than hitting the exact HP. Pushing
// clear of one neighbour can land on the next, so it settles in a few passes
// and gives up rather than shuffling for ever.
function settle(rack, x, y) {
  const size = rackSize(rack);
  const others = planRacks.value.filter((other) => other.id !== rack.id).map(rackBox);
  const from = { x, y };
  let spot = { x, y };
  for (let pass = 0; pass < 8; pass++) {
    const hit = others.find((other) => overlaps({ ...spot, ...size }, other));
    if (!hit) return spot;
    const options = [
      { x: hit.x - size.width, y: spot.y },
      { x: hit.x + hit.width, y: spot.y },
      { x: spot.x, y: hit.y - size.height },
      { x: spot.x, y: hit.y + hit.height },
    ].filter((option) => option.x >= 0 && option.y >= 0);
    if (options.length === 0) return null;
    // Nearest to where it was actually dropped, measured on screen so a
    // rack unit and an HP are compared in the same units the eye sees.
    options.sort(
      (a, b) =>
        Math.hypot((a.x - from.x) * HP_PX, (a.y - from.y) * U_PX) -
        Math.hypot((b.x - from.x) * HP_PX, (b.y - from.y) * U_PX)
    );
    spot = options[0];
  }
  return null;
}

async function dropOnPlan(event) {
  const held = dragged.value;
  dragged.value = null;
  if (!held || !plan.value) return;
  const rack = planRacks.value.find((r) => r.id === held.rack_id);
  if (!rack) return;
  const box = event.currentTarget.getBoundingClientRect();
  // Snap to whole HP and whole rack units: real racks stand on a grid too.
  const x = Math.max(0, Math.round((event.clientX - box.left) / hpPx.value - held.dx));
  const y = Math.max(0, Math.round((event.clientY - box.top) / uPx.value - held.dy));
  const spot = settle(rack, x, y);
  if (!spot) {
    error.value = 'No room there — move another rack out of the way, or make the plan bigger.';
    return;
  }
  error.value = '';
  rack.system_x = spot.x;
  rack.system_y = spot.y;
  await saveArrangement();
}

// ---- which racks are in the system ----
async function assign(rackId, systemId) {
  error.value = '';
  planBusy.value = true;
  try {
    await api.put(`/api/racks/${rackId}/system`, { system_id: systemId });
    plan.value = await api.get(`/api/systems/${plan.value.id}`);
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    planBusy.value = false;
  }
}
</script>

<template>
  <h1>Your systems</h1>
  <p class="muted">
    A system is the set of racks you patch together as one instrument — the studio desk, or the
    live case plus the skiff beside it. Put racks into a system and a patch built from it can run
    a cable from any jack on any of those racks to any jack on any other.
  </p>
  <p class="muted">
    Choose <strong>Arrange racks</strong> to drag each rack into the place it stands in the room.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="notice" class="success" data-test="notice">{{ notice }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else class="panel">
    <div v-if="systems.length" class="table-wrap">
      <table data-test="system-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Racks</th>
            <th>Modules</th>
            <th>Layout</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="system in systems" :key="system.id" :data-test="`system-${system.id}`">
            <td>
              <template v-if="renamingId === system.id">
                <form class="actions" @submit.prevent="rename(system)">
                  <input v-model="renameValue" :data-test="`rename-input-${system.id}`" />
                  <button type="submit" :data-test="`rename-save-${system.id}`">Save</button>
                  <button type="button" @click="renamingId = null">Cancel</button>
                </form>
              </template>
              <template v-else>
                {{ system.name }}
                <span v-if="system.description" class="muted"> — {{ system.description }}</span>
              </template>
            </td>
            <td>{{ system.rack_count }}</td>
            <td>{{ system.module_count }}</td>
            <td>
              <button
                class="secondary"
                style="margin: 0"
                :data-test="`arrange-${system.id}`"
                @click="openPlan(system)"
              >
                {{ openId === system.id ? 'Close plan' : 'Arrange racks' }}
              </button>
            </td>
            <td class="actions-cell">
              <div class="actions nowrap">
                <button
                  v-if="renamingId !== system.id"
                  :data-test="`rename-${system.id}`"
                  @click="startRename(system)"
                >
                  Rename
                </button>
                <button
                  class="secondary"
                  :disabled="system.module_count === 0 || trimming === system.id"
                  :title="
                    system.module_count === 0
                      ? 'This system has no modules to trim panels for'
                      : 'Cut every panel picture in this system down to the front plate'
                  "
                  :data-test="`trim-panels-${system.id}`"
                  @click="trimPanels(system)"
                >
                  Trim All Panels
                </button>
                <button class="danger" :data-test="`delete-${system.id}`" @click="remove(system)">
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted" data-test="empty">
      No systems yet. Create one below, then put your racks into it.
    </p>

    <form @submit.prevent="create">
      <label for="new-system">New system</label>
      <div class="row">
        <input id="new-system" v-model="newName" data-test="new-system" placeholder="e.g. studio" />
        <input
          v-model="newDescription"
          data-test="new-description"
          placeholder="Description (optional)"
          style="flex: 2"
        />
        <div class="shrink">
          <button type="submit" style="margin: 0" :disabled="!newName.trim()" data-test="create">
            Create
          </button>
        </div>
      </div>
    </form>

    <section v-if="plan" class="system-plan" data-test="system-plan">
      <h2>Arrange {{ plan.name }}</h2>
      <p class="muted">
        Drag each rack to where it stands. Boxes are drawn to scale — as wide as the rack's widest
        row in HP and as tall as its rows are in U — and no two racks may stand in the same place,
        so a rack dropped onto its neighbour comes to rest flush beside it. Drag the floor's
        right or bottom edge — or the corner — to give the studio more room.
      </p>

      <div class="plan-controls">
        <label class="plan-field">
          Plan width (HP)
          <input
            type="number"
            min="20"
            max="5000"
            step="4"
            :value="plan.floor_width"
            :disabled="floorBusy"
            data-test="floor-width"
            @change="resizeFloor(Number($event.target.value), plan.floor_height)"
          />
        </label>
        <label class="plan-field">
          Plan height (U)
          <input
            type="number"
            min="3"
            max="5000"
            step="1"
            :value="plan.floor_height"
            :disabled="floorBusy"
            data-test="floor-height"
            @change="resizeFloor(plan.floor_width, Number($event.target.value))"
          />
        </label>
        <label class="plan-field">
          Zoom {{ Math.round(zoom * 100) }}%
          <input
            type="range"
            min="25"
            max="100"
            step="5"
            :value="zoom * 100"
            data-test="plan-zoom"
            @input="zoom = Number($event.target.value) / 100"
          />
        </label>
      </div>

      <div class="plan-viewport" data-test="plan-viewport">
        <div
          class="plan-floor"
          :class="{ resizing: !!resizing }"
          :style="planStyle"
          data-test="plan-floor"
          @dragover.prevent
          @drop.prevent="dropOnPlan"
        >
          <p v-if="planRacks.length === 0" class="muted plan-empty" data-test="plan-empty">
            No racks in this system yet — add one from the list below.
          </p>
          <div
            v-for="rack in planRacks"
            :key="rack.id"
            class="plan-rack"
            :style="rackStyle(rack)"
            :data-test="`plan-rack-${rack.id}`"
            draggable="true"
            @dragstart="startPlanDrag(rack, $event)"
          >
            <div class="plan-rack-name">
              {{ rack.name }}
              <button
                class="danger plan-remove"
                :disabled="planBusy"
                :data-test="`unassign-${rack.id}`"
                @click.stop="assign(rack.id, null)"
              >
                Remove
              </button>
            </div>
            <div v-for="row in rack.rows" :key="row.id" class="plan-row" :style="rowStyle(row)">
              <div
                v-for="module in row.modules"
                :key="module.id"
                class="plan-module"
                :style="moduleStyle(module)"
                :title="`${module.manufacturer} ${module.name}`"
              >
                <img
                  v-if="module.panel"
                  :src="module.panel.url"
                  :style="panelCropStyle(module.panel)"
                  :alt="`${module.manufacturer} ${module.name}`"
                />
              </div>
            </div>
            <p v-if="!rack.rows.length" class="muted plan-no-rows">
              No rows yet — organize this rack to draw its panels here.
            </p>
          </div>
          <!-- The floor's own edges: drag one to make the studio bigger. -->
          <div
            class="plan-resize plan-resize-right"
            title="Drag to set how wide the plan is"
            data-test="plan-resize-right"
            @pointerdown="startResize('right', $event)"
            @pointermove="moveResize"
            @pointerup="endResize"
            @pointercancel="endResize"
          ></div>
          <div
            class="plan-resize plan-resize-bottom"
            title="Drag to set how tall the plan is"
            data-test="plan-resize-bottom"
            @pointerdown="startResize('bottom', $event)"
            @pointermove="moveResize"
            @pointerup="endResize"
            @pointercancel="endResize"
          ></div>
          <div
            class="plan-resize plan-resize-corner"
            title="Drag to resize the plan"
            data-test="plan-resize-corner"
            @pointerdown="startResize('corner', $event)"
            @pointermove="moveResize"
            @pointerup="endResize"
            @pointercancel="endResize"
          ></div>
        </div>
      </div>

      <h3>Racks not in a system</h3>
      <p v-if="unassigned.length === 0" class="muted" data-test="no-unassigned">
        Every rack of yours is in a system.
      </p>
      <div v-else class="actions" data-test="unassigned-racks">
        <button
          v-for="rack in unassigned"
          :key="rack.id"
          class="secondary"
          :disabled="planBusy"
          :data-test="`assign-${rack.id}`"
          @click="assign(rack.id, plan.id)"
        >
          Add {{ rack.name }} ({{ rack.module_count }} modules)
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.system-plan { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem; }
.plan-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; }
.plan-field { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: var(--muted); margin: 0; }
.plan-field input[type='number'] { width: 6rem; margin: 0; }
.plan-field input[type='range'] { width: 8rem; margin: 0; }
/* The floor is drawn at exactly the size the plan says — a wide studio is
   read by scrolling the viewport around it, so making the plan wider than
   the screen is still visibly wider. */
.plan-viewport { margin: 1rem 0; max-width: 100%; overflow: auto; }
.plan-floor { position: relative; background: #15151b; border: 2px solid var(--border-strong); border-radius: 5px; }
/* Grab an edge of the floor and pull to say how much room the studio has.
   The strips sit inside the floor so they move with it as it grows. */
.plan-resize { position: absolute; z-index: 2; background: transparent; }
.plan-resize:hover, .plan-floor.resizing .plan-resize { background: var(--accent); opacity: 0.5; }
.plan-resize-right { top: 0; right: 0; width: 10px; height: 100%; cursor: ew-resize; }
.plan-resize-bottom { left: 0; bottom: 0; width: 100%; height: 10px; cursor: ns-resize; }
.plan-resize-corner { right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; background: var(--border-strong); border-radius: 4px 0 3px 0; }
.plan-resize-corner:hover, .plan-floor.resizing .plan-resize-corner { opacity: 1; }
.plan-floor.resizing { user-select: none; }
.plan-empty { position: absolute; inset: 0; display: grid; place-items: center; }
/* A rack's box is exactly its footprint — the same HP and U the server keeps
   racks from overlapping in — so the name bar floats over the panels rather
   than making the box taller than the case really is. */
.plan-rack { position: absolute; box-sizing: border-box; overflow: hidden; background: #25252d; border: 1px solid var(--border-strong); border-radius: 4px; cursor: grab; }
.plan-rack-name { position: absolute; inset: 0 0 auto 0; z-index: 1; display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; padding: 0.1rem 0.3rem; color: var(--text); background: rgba(16, 16, 21, 0.75); pointer-events: none; }
.plan-remove { pointer-events: auto; margin: 0 0 0 auto; padding: 0 0.3rem; font-size: 0.65rem; }
.plan-row { display: flex; align-items: stretch; gap: 1px; overflow: hidden; background: #101015; }
/* Like the rack organizer: the box is the module's footprint and the picture
   is offset by its crop, so a photo's blank backdrop is not drawn as panel. */
.plan-module { position: relative; background: #33333d; overflow: hidden; }
.plan-module img { position: absolute; display: block; object-fit: fill; }
.plan-no-rows { font-size: 0.7rem; padding: 0 0.3rem 0.3rem; }
</style>
