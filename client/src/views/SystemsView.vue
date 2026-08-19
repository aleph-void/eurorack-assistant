<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';

// A system is a group of racks patched together as one instrument. This page
// lists them, assigns racks in and out, and arranges the racks of one system
// on a floor plan so the picture matches the studio.

const systems = ref([]);
const error = ref('');
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
const HP_PX = 4;
const U_PX = 26;

const rackSize = (rack) => {
  const rows = rack.rows || [];
  const width = rows.reduce((max, row) => Math.max(max, Number(row.hp) || 0), 0) || 84;
  const height = rows.reduce((sum, row) => sum + (Number(row.unit) || 3), 0) || 3;
  return { width, height };
};

const planRacks = computed(() => plan.value?.racks || []);
const unassigned = computed(() => plan.value?.unassigned_racks || []);

// How big the plan needs to be to hold every rack where it stands.
const planExtent = computed(() => {
  let width = 140;
  let height = 9;
  for (const rack of planRacks.value) {
    const size = rackSize(rack);
    width = Math.max(width, (Number(rack.system_x) || 0) + size.width + 8);
    height = Math.max(height, (Number(rack.system_y) || 0) + size.height + 2);
  }
  return { width: width * HP_PX, height: height * U_PX };
});

const rackStyle = (rack) => {
  const size = rackSize(rack);
  return {
    left: `${(Number(rack.system_x) || 0) * HP_PX}px`,
    top: `${(Number(rack.system_y) || 0) * U_PX}px`,
    width: `${size.width * HP_PX}px`,
  };
};
const rowStyle = (row) => ({ height: `${(Number(row.unit) || 3) * U_PX}px` });
const moduleStyle = (module) => ({ width: `${(Number(module.hp) || 4) * HP_PX}px` });

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
    dx: (event.clientX - box.left) / HP_PX,
    dy: (event.clientY - box.top) / U_PX,
  };
}

async function dropOnPlan(event) {
  const held = dragged.value;
  dragged.value = null;
  if (!held || !plan.value) return;
  const rack = planRacks.value.find((r) => r.id === held.rack_id);
  if (!rack) return;
  const box = event.currentTarget.getBoundingClientRect();
  // Snap to whole HP and whole rack units: real racks stand on a grid too.
  rack.system_x = Math.max(0, Math.round((event.clientX - box.left) / HP_PX - held.dx));
  rack.system_y = Math.max(0, Math.round((event.clientY - box.top) / U_PX - held.dy));
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
        row in HP and as tall as its rows are in U.
      </p>

      <div
        class="plan-floor"
        :style="{ width: `${planExtent.width}px`, height: `${planExtent.height}px` }"
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
                :alt="`${module.manufacturer} ${module.name}`"
              />
            </div>
          </div>
          <p v-if="!rack.rows.length" class="muted plan-no-rows">
            No rows yet — organize this rack to draw its panels here.
          </p>
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
.plan-floor { position: relative; margin: 1rem 0; max-width: 100%; overflow: auto; background: #15151b; border: 2px solid var(--border-strong); border-radius: 5px; }
.plan-empty { position: absolute; inset: 0; display: grid; place-items: center; }
.plan-rack { position: absolute; background: #25252d; border: 1px solid var(--border-strong); border-radius: 4px; cursor: grab; padding-bottom: 2px; }
.plan-rack-name { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; padding: 0.15rem 0.3rem; color: var(--muted); }
.plan-remove { margin: 0 0 0 auto; padding: 0 0.3rem; font-size: 0.65rem; }
.plan-row { display: flex; align-items: stretch; gap: 1px; overflow: hidden; margin: 0 2px 1px; background: #101015; }
.plan-module { background: #33333d; overflow: hidden; }
.plan-module img { display: block; width: 100%; height: 100%; object-fit: fill; }
.plan-no-rows { font-size: 0.7rem; padding: 0 0.3rem 0.3rem; }
</style>
