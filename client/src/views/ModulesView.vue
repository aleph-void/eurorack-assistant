<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { useJobsStore } from '../stores/jobs.js';
import ChannelScanPanel from '../components/ChannelScanPanel.vue';

const route = useRoute();
const modules = ref([]);
const racks = ref([]);
// '' shows every rack (deduped); a rack id narrows the list to that rack.
const selectedRack = ref(route.query.rack ? Number(route.query.rack) : '');
const error = ref('');
const loading = ref(true);
const jobs = useJobsStore();
const COMPONENT_TYPES = [
  'input_jack',
  'output_jack',
  'bidirectional_jack',
  'knob',
  'slider',
  'button',
  'toggle',
  'switch',
  'display',
  'other',
];
const expandedComponents = ref({});
const moduleComponents = ref({});
const componentDrafts = ref({});
const componentError = ref({});
const componentNotice = ref({});

// Free-text narrowing of the list by manufacturer or module name. Every
// whitespace-separated word has to appear somewhere in the two of them, so
// 'make maths' finds Make Noise Maths and 'noise 2hp' finds nothing.
const filterText = ref('');
const filterTerms = computed(() =>
  filterText.value.toLowerCase().split(/\s+/).filter(Boolean)
);
const filteredModules = computed(() => {
  if (!filterTerms.value.length) return modules.value;
  return modules.value.filter((m) => {
    const haystack = `${m.manufacturer || ''} ${m.name || ''}`.toLowerCase();
    return filterTerms.value.every((term) => haystack.includes(term));
  });
});

const currentRack = computed(() => racks.value.find((r) => r.id === selectedRack.value) || null);
const otherRacks = computed(() => racks.value.filter((r) => r.id !== selectedRack.value));

// One collapsible section per rack, so a system of several racks reads as
// the racks it is made of instead of one long list. A module in two racks is
// listed under both; one in none (its rack was deleted out from under it)
// still has somewhere to appear.
// While a filter is typed, a rack the filter empties is left out entirely
// rather than shown as an empty section.
const rackGroups = computed(() => {
  const shown = filteredModules.value;
  if (currentRack.value) return [{ rack: currentRack.value, modules: shown }];
  const groups = racks.value
    .map((rack) => ({
      rack,
      modules: shown.filter((m) => (m.racks || []).some((r) => r.id === rack.id)),
    }))
    .filter((group) => group.modules.length || !filterTerms.value.length);
  const loose = shown.filter((m) => !(m.racks || []).length);
  return loose.length ? [...groups, { rack: null, modules: loose }] : groups;
});

async function load() {
  try {
    racks.value = await api.get('/api/racks');
    const query = selectedRack.value ? `?rack_id=${selectedRack.value}` : '';
    modules.value = await api.get(`/api/modules${query}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function rackNames(module) {
  return (module.racks || []).map((r) => r.name).join(', ');
}

function moduleHref(module, rack) {
  return rack ? `/modules/${module.id}?rack=${rack.id}` : `/modules/${module.id}`;
}

async function remove(module) {
  const where = currentRack.value ? `from rack '${currentRack.value.name}'` : 'from all your racks';
  const ok = await dialog.confirm({
    title: 'Remove module',
    message:
      `Remove ${module.manufacturer} ${module.name} ${where}? ` +
      'Its manual, analysis and panel stay on the server, so importing it ' +
      'again brings the module back with all of that work — and your notes ' +
      'and questions about it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const query = selectedRack.value ? `?rack_id=${selectedRack.value}` : '';
    await api.delete(`/api/modules/${module.id}${query}`);
    modules.value = modules.value.filter((m) => m.id !== module.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function toggleComponents(module) {
  if (expandedComponents.value[module.id]) {
    expandedComponents.value = { ...expandedComponents.value, [module.id]: false };
    return;
  }
  error.value = '';
  componentError.value = { ...componentError.value, [module.id]: '' };
  componentNotice.value = { ...componentNotice.value, [module.id]: '' };
  try {
    const detail = await api.get(`/api/modules/${module.id}`);
    moduleComponents.value = { ...moduleComponents.value, [module.id]: detail.components || [] };
    componentDrafts.value = {
      ...componentDrafts.value,
      [module.id]: componentDrafts.value[module.id] || { name: '', type: 'input_jack' },
    };
    expandedComponents.value = { ...expandedComponents.value, [module.id]: true };
  } catch (e) {
    error.value = e.message;
  }
}

async function addComponent(module) {
  const draft = componentDrafts.value[module.id] || {};
  componentError.value = { ...componentError.value, [module.id]: '' };
  componentNotice.value = { ...componentNotice.value, [module.id]: '' };
  try {
    const component = await api.post(`/api/modules/${module.id}/components`, {
      name: draft.name,
      type: draft.type,
    });
    moduleComponents.value = {
      ...moduleComponents.value,
      [module.id]: [...(moduleComponents.value[module.id] || []), component],
    };
    componentDrafts.value = {
      ...componentDrafts.value,
      [module.id]: { name: '', type: draft.type },
    };
    if (component.panel_placement_id) {
      componentNotice.value = {
        ...componentNotice.value,
        [module.id]: 'A panel marker was added. Open the module to drag it onto the hardware.',
      };
    }
  } catch (e) {
    componentError.value = { ...componentError.value, [module.id]: e.message };
  }
}

async function removeComponent(module, component) {
  const ok = await dialog.confirm({
    title: 'Remove component',
    message: `Remove ${component.name} (${component.type}) from ${module.manufacturer} ${module.name}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  componentError.value = { ...componentError.value, [module.id]: '' };
  try {
    await api.delete(`/api/modules/${module.id}/components/${component.id}`);
    moduleComponents.value = {
      ...moduleComponents.value,
      [module.id]: (moduleComponents.value[module.id] || []).filter((c) => c.id !== component.id),
    };
  } catch (e) {
    componentError.value = { ...componentError.value, [module.id]: e.message };
  }
}

// Move a module from the selected rack into another one (quantities merge if
// the target rack already has it).
async function move(module, event) {
  const toRackId = Number(event.target.value);
  event.target.value = '';
  if (!toRackId) return;
  error.value = '';
  try {
    await api.post(`/api/racks/${selectedRack.value}/modules/${module.id}/move`, {
      to_rack_id: toRackId,
    });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// ---- moving a selection of modules at once ----
// Reorganizing a case is a job of many modules, not one dropdown at a time.
// The selection is per rack group and keyed by rack, because a module can sit
// in two racks and ticking it under one says nothing about the other — and
// the group's rack is the source the move runs from.
const selection = ref({});
const moveTarget = ref({});
const moving = ref(false);
const moveNotice = ref('');

const selectedIn = (rackId) => selection.value[rackId] ?? [];
const isSelected = (rackId, moduleId) => selectedIn(rackId).includes(moduleId);

function toggleSelected(rackId, moduleId) {
  const current = selectedIn(rackId);
  selection.value = {
    ...selection.value,
    [rackId]: current.includes(moduleId)
      ? current.filter((id) => id !== moduleId)
      : [...current, moduleId],
  };
}

// The header box ticks everything the filter currently shows, and unticks
// the lot when they are already all ticked.
function toggleAllIn(group) {
  const ids = group.modules.map((m) => m.id);
  const allOn = ids.length > 0 && ids.every((id) => isSelected(group.rack.id, id));
  selection.value = { ...selection.value, [group.rack.id]: allOn ? [] : ids };
}
const allSelectedIn = (group) =>
  group.modules.length > 0 && group.modules.every((m) => isSelected(group.rack.id, m.id));

async function moveSelected(rack) {
  const moduleIds = selectedIn(rack.id);
  const toRackId = Number(moveTarget.value[rack.id]);
  if (!moduleIds.length || !toRackId) return;
  error.value = '';
  moveNotice.value = '';
  moving.value = true;
  try {
    const res = await api.post(`/api/racks/${rack.id}/modules/move`, {
      to_rack_id: toRackId,
      module_ids: moduleIds,
    });
    const target = racks.value.find((r) => r.id === toRackId);
    moveNotice.value =
      `Moved ${res.moved} module(s) from '${rack.name}' to '${target?.name ?? 'the other rack'}'.`;
    selection.value = { ...selection.value, [rack.id]: [] };
    moveTarget.value = { ...moveTarget.value, [rack.id]: '' };
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    moving.value = false;
  }
}

// A rack a module can be moved TO: any of the user's racks but the one the
// group is showing.
const targetsFor = (rackId) => racks.value.filter((r) => r.id !== rackId);

// Fill the gaps across the whole system (or the selected rack): a module with
// no manual, no analyzed components, no front panel picture, no HP width or
// components lacking a description (added by hand after the import)
// gets the one job that would supply what it is missing, and a module that
// already has all of it is left alone — re-running a complete analysis costs
// a model run and overwrites corrections made by hand. Re-discovering the
// manuals is a separate, heavier step: it costs a web search per module, so
// it is off unless asked for.
const rediscoverManuals = ref(false);
// Panels are the one part of this that goes stale on its own: the markers on
// an existing panel were placed by the code as it stood when the job ran, so
// improving how panels are built is a reason to redo every one of them that
// nothing about the modules themselves would ever signal.
const rebuildPanels = ref(false);
const reanalyzing = ref(false);
const reanalyzed = ref('');

async function reanalyzeAll() {
  const where = currentRack.value ? `in '${currentRack.value.name}'` : 'in all your racks';
  const extra = rediscoverManuals.value
    ? ' Modules still missing their analysis will have their manuals searched for again first.'
    : '';
  const panels = rebuildPanels.value
    ? ' Every analyzed module will also have its front panel rebuilt, even if it already has one' +
      ' — a picture you uploaded is kept, and only its markers are worked out again.'
    : '';
  const ok = await dialog.confirm({
    title: 'Fill in missing details',
    message:
      `Queue work for every module ${where} that is missing a manual, an analysis, ` +
      `a panel image, an HP width, the searchable text of its manual, or descriptions ` +
      `for components added by hand?${extra}${panels}`,
    confirmLabel: 'Fill in',
  });
  if (!ok) return;
  error.value = '';
  reanalyzed.value = '';
  reanalyzing.value = true;
  try {
    const res = await api.post('/api/modules/reanalyze', {
      rack_id: selectedRack.value || undefined,
      rediscover_manuals: rediscoverManuals.value,
      rebuild_panels: rebuildPanels.value,
    });
    const queued = Object.values(res.queued).reduce((sum, n) => sum + n, 0);
    const complete = `${res.complete} of ${res.modules} module(s) already complete`;
    reanalyzed.value =
      queued === 0
        ? `Nothing to queue — ${complete}` +
          (res.skipped ? `, and ${res.skipped} already had a job waiting.` : '.')
        : `Queued ${queued} job(s) — ${complete}` +
          (res.skipped ? `; ${res.skipped} already had one waiting.` : '.');
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    reanalyzing.value = false;
  }
}

watch(selectedRack, load);

// Live-refresh when background jobs finish (manual found, analysis complete).
let refreshTimer = null;
watch(
  () => jobs.feed.length,
  () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      load();
    }, 500);
  }
);

onMounted(load);
onUnmounted(() => clearTimeout(refreshTimer));
</script>

<template>
  <h1>Your modules</h1>
  <div class="row">
    <div>
      <label for="rack-select">Rack</label>
      <select id="rack-select" v-model="selectedRack" data-test="rack-select">
        <option value="">All racks</option>
        <option v-for="rack in racks" :key="rack.id" :value="rack.id">{{ rack.name }}</option>
      </select>
    </div>
    <div style="flex: 2">
      <label for="module-filter">Filter</label>
      <input
        id="module-filter"
        v-model="filterText"
        type="search"
        placeholder="Name or manufacturer"
        data-test="module-filter"
      />
    </div>
    <div class="shrink" style="align-self: end; white-space: nowrap">
      <RouterLink to="/racks">Manage racks</RouterLink>
    </div>
  </div>
  <div v-if="modules.length" class="row reanalyze-row">
    <button
      class="secondary"
      style="margin: 0"
      :disabled="reanalyzing"
      data-test="reanalyze-all"
      @click="reanalyzeAll"
    >
      {{ reanalyzing ? 'Queueing…' : 'Fill in missing details' }}
    </button>
    <label class="inline-check">
      <input v-model="rediscoverManuals" type="checkbox" data-test="rediscover-manuals" />
      Re-discover manuals too
    </label>
    <label class="inline-check">
      <input v-model="rebuildPanels" type="checkbox" data-test="rebuild-panels" />
      Rebuild every panel
    </label>
  </div>
  <p v-if="filterTerms.length && !loading && modules.length" class="muted" data-test="filter-count">
    {{ filteredModules.length }} of {{ modules.length }}
    {{ modules.length === 1 ? 'module' : 'modules' }} match “{{ filterText.trim() }}”.
    <button class="linklike" data-test="clear-filter" @click="filterText = ''">Clear filter</button>
  </p>
  <p v-if="reanalyzed" class="muted" data-test="reanalyze-result">{{ reanalyzed }}</p>
  <p v-if="moveNotice" class="success" data-test="move-notice">{{ moveNotice }}</p>
  <!-- Rack-scoped: scanning a channel means matching against one rack's modules. -->
  <ChannelScanPanel v-if="currentRack && modules.length" :rack-id="currentRack.id" />
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="loading" class="muted">Loading…</p>
  <div v-else-if="modules.length === 0" class="panel">
    <p>
      No modules {{ currentRack ? `in '${currentRack.name}'` : 'yet' }}.
      <RouterLink to="/import">Import your module list</RouterLink> to get started.
    </p>
  </div>
  <div v-else-if="filteredModules.length === 0" class="panel" data-test="no-matches">
    <p>No module's name or manufacturer matches “{{ filterText.trim() }}”.</p>
  </div>
  <template v-else>
    <!-- Each rack folds away behind its name; the first one starts open. -->
    <details
      v-for="(group, i) in rackGroups"
      :key="group.rack?.id ?? 'unracked'"
      class="panel"
      :open="i === 0"
      :data-test="`rack-group-${group.rack?.id ?? 'unracked'}`"
    >
      <summary>
        <h2>{{ group.rack ? group.rack.name : 'Not in a rack' }}</h2>
        <span class="summary-count">
          {{ group.modules.length }} {{ group.modules.length === 1 ? 'module' : 'modules' }}
        </span>
      </summary>
      <div class="panel-body">
        <!-- Bulk move: tick the modules, pick where they go, move them. Only
             offered where there is a rack to move out of and one to move
             into. -->
        <div
          v-if="group.rack && group.modules.length && targetsFor(group.rack.id).length"
          class="row bulk-move"
          :data-test="`bulk-move-${group.rack.id}`"
        >
          <span class="muted shrink" style="white-space: nowrap">
            {{ selectedIn(group.rack.id).length }} selected
          </span>
          <div>
            <select
              v-model="moveTarget[group.rack.id]"
              :data-test="`bulk-target-${group.rack.id}`"
              aria-label="Move selected modules to"
            >
              <option value="">Move selected to…</option>
              <option v-for="rack in targetsFor(group.rack.id)" :key="rack.id" :value="rack.id">
                {{ rack.name }}
              </option>
            </select>
          </div>
          <div class="shrink">
            <button
              style="margin: 0"
              :disabled="moving || !selectedIn(group.rack.id).length || !moveTarget[group.rack.id]"
              :data-test="`bulk-move-go-${group.rack.id}`"
              @click="moveSelected(group.rack)"
            >
              {{ moving ? 'Moving…' : 'Move' }}
            </button>
          </div>
          <div v-if="selectedIn(group.rack.id).length" class="shrink">
            <button
              class="secondary"
              style="margin: 0"
              :data-test="`bulk-clear-${group.rack.id}`"
              @click="selection = { ...selection, [group.rack.id]: [] }"
            >
              Clear
            </button>
          </div>
        </div>
        <div v-if="group.modules.length" class="table-wrap">
          <table data-test="module-table">
            <thead>
              <tr>
                <th v-if="group.rack && targetsFor(group.rack.id).length" class="select-cell">
                  <input
                    type="checkbox"
                    :checked="allSelectedIn(group)"
                    :data-test="`select-all-${group.rack.id}`"
                    :aria-label="`Select every module in ${group.rack.name}`"
                    @change="toggleAllIn(group)"
                  />
                </th>
                <th>Manufacturer</th>
                <th>Module</th>
                <th>Qty</th>
                <th>HP</th>
                <th v-if="!currentRack">Rack(s)</th>
                <th>Manual</th>
                <th>Analysis</th>
                <th>Panel</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="module in group.modules" :key="module.id">
              <tr :data-test="`module-${module.id}`">
                <td v-if="group.rack && targetsFor(group.rack.id).length" class="select-cell">
                  <input
                    type="checkbox"
                    :checked="isSelected(group.rack.id, module.id)"
                    :data-test="`select-${group.rack.id}-${module.id}`"
                    :aria-label="`Select ${module.manufacturer} ${module.name}`"
                    @change="toggleSelected(group.rack.id, module.id)"
                  />
                </td>
                <td>{{ module.manufacturer }}</td>
                <td>
                  <RouterLink :to="moduleHref(module, group.rack)">{{ module.name }}</RouterLink>
                </td>
                <td>{{ module.quantity }}</td>
                <td>{{ module.hp ? `${module.hp}HP` : '—' }}</td>
                <td v-if="!currentRack">{{ rackNames(module) }}</td>
                <td><span class="badge" :class="module.manual_status">{{ module.manual_status }}</span></td>
                <td>
                  <span class="badge" :class="module.analysis_status">{{ module.analysis_status }}</span>
                </td>
                <td>
                  <span class="badge" :class="module.panel_status">{{ module.panel_status }}</span>
                </td>
                <td class="module-actions-cell">
                  <div class="module-row-actions">
                    <button
                      class="secondary"
                      :data-test="`components-${module.id}`"
                      @click="toggleComponents(module)"
                    >
                      {{ expandedComponents[module.id] ? 'Hide components' : 'Components' }}
                    </button>
                    <select
                      v-if="currentRack && otherRacks.length > 0"
                      class="move-select"
                      :data-test="`move-${module.id}`"
                      @change="move(module, $event)"
                    >
                      <option value="">Move to…</option>
                      <option v-for="rack in otherRacks" :key="rack.id" :value="rack.id">
                        {{ rack.name }}
                      </option>
                    </select>
                    <button
                      class="danger"
                      :data-test="`delete-${module.id}`"
                      @click="remove(module)"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedComponents[module.id]" :data-test="`component-editor-${module.id}`">
                <td
                  :colspan="
                    (currentRack ? 8 : 9) +
                    (group.rack && targetsFor(group.rack.id).length ? 1 : 0)
                  "
                >
                  <div class="row" style="align-items: end">
                    <div style="flex: 2">
                      <label :for="`component-name-${module.id}`">Component name</label>
                      <input
                        :id="`component-name-${module.id}`"
                        v-model="componentDrafts[module.id].name"
                        :data-test="`component-name-${module.id}`"
                        placeholder="e.g. ROOT"
                        @keyup.enter="addComponent(module)"
                      />
                    </div>
                    <div>
                      <label :for="`component-type-${module.id}`">Type</label>
                      <select
                        :id="`component-type-${module.id}`"
                        v-model="componentDrafts[module.id].type"
                        :data-test="`component-type-${module.id}`"
                      >
                        <option v-for="type in COMPONENT_TYPES" :key="type" :value="type">{{ type }}</option>
                      </select>
                    </div>
                    <div class="shrink">
                      <button
                        style="margin: 0"
                        :disabled="!componentDrafts[module.id].name.trim()"
                        :data-test="`add-component-${module.id}`"
                        @click="addComponent(module)"
                      >
                        Add component
                      </button>
                    </div>
                  </div>
                  <p v-if="componentError[module.id]" class="error">{{ componentError[module.id] }}</p>
                  <p v-if="componentNotice[module.id]" class="muted">{{ componentNotice[module.id] }}</p>
                  <ul v-if="moduleComponents[module.id]?.length" class="component-list">
                    <li v-for="component in moduleComponents[module.id]" :key="component.id">
                      <span>{{ component.name }} <span class="muted">({{ component.type }})</span></span>
                      <button
                        class="danger"
                        style="margin: 0"
                        :data-test="`remove-component-${component.id}`"
                        @click="removeComponent(module, component)"
                      >
                        Remove
                      </button>
                    </li>
                  </ul>
                  <p v-else class="muted">No components yet.</p>
                </td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">
          No modules in this rack.
          <RouterLink to="/import">Import a module list</RouterLink> to fill it.
        </p>
      </div>
    </details>
  </template>
</template>
