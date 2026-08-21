<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { COMPONENT_TYPES, TYPE_LABELS, componentColor } from '../componentTypes.js';
import { dialog } from '../dialog.js';
import ModulePanel from '../components/ModulePanel.vue';
import NormalizationsSection from '../components/moduledetail/NormalizationsSection.vue';
import SwitchesSection from '../components/moduledetail/SwitchesSection.vue';
import RoutesSection from '../components/moduledetail/RoutesSection.vue';
import PairsSection from '../components/moduledetail/PairsSection.vue';
import ExpandersSection from '../components/moduledetail/ExpandersSection.vue';
import BridgesSection from '../components/moduledetail/BridgesSection.vue';
import ValuesSection from '../components/moduledetail/ValuesSection.vue';
import DocumentsSection from '../components/moduledetail/DocumentsSection.vue';
import VideosSection from '../components/moduledetail/VideosSection.vue';
import NotesSection from '../components/moduledetail/NotesSection.vue';
import { useModuleFacts } from '../components/moduledetail/useModuleFacts.js';
import { fileToBase64 } from '../files.js';
import { placementFraction } from '../panelLayout.js';

const props = defineProps({ id: { type: String, required: true } });

const route = useRoute();
const module = ref(null);
const error = ref('');

const { componentName } = useModuleFacts(module);

// --- Naming/HP correction (shared record: a fix shows for every user).
// Saved with a plain PATCH — no re-analysis is triggered. ---
const editingNaming = ref(false);
const editManufacturer = ref('');
const editModuleName = ref('');
const editHp = ref('');
const savingNaming = ref(false);
const namingError = ref('');

function startEditNaming() {
  editManufacturer.value = module.value.manufacturer;
  editModuleName.value = module.value.name;
  editHp.value = module.value.hp == null ? '' : String(module.value.hp);
  namingError.value = '';
  editingNaming.value = true;
}

async function saveNaming() {
  const manufacturer = editManufacturer.value.trim();
  const name = editModuleName.value.trim();
  const hp = editHp.value.trim();
  if (!manufacturer || !name) {
    namingError.value = 'Manufacturer and name are both required';
    return;
  }
  savingNaming.value = true;
  namingError.value = '';
  try {
    await api.patch(`/api/modules/${props.id}`, { manufacturer, name, hp: hp || null });
    editingNaming.value = false;
    await load();
  } catch (e) {
    namingError.value = e.message;
  } finally {
    savingNaming.value = false;
  }
}

// --- Rack quantity correction (how many copies each rack contains) ---
const editingQuantities = ref(false);
const editQuantities = ref({});
const savingQuantities = ref(false);
const quantityError = ref('');

function startEditQuantities() {
  editQuantities.value = Object.fromEntries(
    module.value.racks.map((r) => [r.id, String(r.quantity)])
  );
  quantityError.value = '';
  editingQuantities.value = true;
}

async function saveQuantities() {
  const changes = [];
  for (const rack of module.value.racks) {
    const quantity = Number(String(editQuantities.value[rack.id] ?? '').trim());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      quantityError.value = `Quantity in ${rack.name} must be a whole number between 1 and 99`;
      return;
    }
    if (quantity !== rack.quantity) changes.push({ rack, quantity });
  }
  savingQuantities.value = true;
  quantityError.value = '';
  try {
    for (const { rack, quantity } of changes) {
      await api.put(`/api/racks/${rack.id}/modules/${props.id}`, { quantity });
    }
    editingQuantities.value = false;
    await load();
  } catch (e) {
    quantityError.value = e.message;
  } finally {
    savingQuantities.value = false;
  }
}

// --- Component re-analysis with fresh retailer product pages ---
const reanalyzing = ref(false);
const reanalyzeNotice = ref('');
const reanalyzeError = ref('');
// The saved renders the re-analysis job would fetch. While any of them is
// already among the module's documents the button stays disabled (the server
// refuses on the same test): the point of the action is fetching them fresh.
const RETAILER_PAGE_RE = /_(Perfect_Circuit|Detroit_Modular|Midwest_Modular)_Product_Page\.pdf$/i;
const retailerPagesExist = computed(() =>
  (module.value?.manuals || []).some(
    (d) => d.user_id === null && RETAILER_PAGE_RE.test(d.original_name || '')
  )
);

// Shown as the button's hover tooltip rather than inline text.
const reanalyzeTitle = computed(() =>
  retailerPagesExist.value
    ? 'Retailer product pages already exist for this module (see Documents), so there is nothing new to fetch.'
    : "Fetches the module's product page from Perfect Circuit, Detroit Modular and Midwest Modular and re-analyzes the components with every page it finds."
);

const rebuildTitle =
  'Runs the manual analysis again with the saved documents marked for analysis in Documents below. Nothing new is downloaded.';

async function reanalyzeComponents() {
  reanalyzeNotice.value = '';
  reanalyzeError.value = '';
  reanalyzing.value = true;
  try {
    await api.post(`/api/modules/${props.id}/reanalyze`);
    reanalyzeNotice.value =
      'Re-analysis queued: retailer product pages will be downloaded and the components analyzed again.';
    await load();
  } catch (e) {
    reanalyzeError.value = e.message;
  } finally {
    reanalyzing.value = false;
  }
}

// --- Analysis rebuild from the documents already on disk ---
const rebuilding = ref(false);
const rebuildNotice = ref('');
const rebuildError = ref('');

async function rebuildAnalysis() {
  rebuildNotice.value = '';
  rebuildError.value = '';
  rebuilding.value = true;
  try {
    await api.post(`/api/modules/${props.id}/analyze`);
    rebuildNotice.value =
      'Analysis queued: the manual and any saved vendor pages will be analyzed again.';
    await load();
  } catch (e) {
    rebuildError.value = e.message;
  } finally {
    rebuilding.value = false;
  }
}

// 'Input jacks' → 'input jack'; 'Bidirectional jacks (mults)' loses its
// parenthetical before the plural s is dropped.
const singularLabel = (group) =>
  group.label.toLowerCase().replace(/\s*\(.*\)$/, '').replace(/s$/, '');

const grouped = computed(() => {
  if (!module.value?.components) return [];
  // Every type gets a section, in the canonical order, whether the analysis
  // found one or not: each section is also the entry point for adding a
  // component of that type by hand, and a module with no sliders is exactly
  // where a missing slider has to be added. A type this build does not know
  // about still gets its own section, after the ten.
  const groups = new Map(COMPONENT_TYPES.map((type) => [type, []]));
  for (const c of module.value.components) {
    if (!groups.has(c.type)) groups.set(c.type, []);
    groups.get(c.type).push(c);
  }
  return [...groups.entries()].map(([type, components]) => ({
    type,
    label: TYPE_LABELS[type] || type,
    components,
  }));
});

// The physical connector, for connection points that are not ordinary 3.5mm
// patch points.
const PORT_KINDS = [
  'midi_din',
  'midi_trs',
  'usb',
  'spdif',
  'adat',
  'audio_quarter_inch',
  'audio_rca',
  'ethernet',
  'microphone',
  'speaker',
  'memory_card',
  'ribbon',
  'other',
];
const portKindLabel = (kind) => (kind ? kind.replace(/_/g, ' ') : '3.5mm');

// 'generator' for outputs nothing feeds, otherwise the inputs that reach it.
function outputSignalSource(c) {
  const feeding = (module.value?.routes || [])
    .filter((r) => r.output_component_id === c.id)
    .map((r) => componentName(r.input_component_id));
  return feeding.length === 0 ? 'generator' : `fed by ${feeding.join(', ')}`;
}

const rackModules = ref([]);

// Keep detail-page navigation in the rack the user came from. A direct visit
// has no rack in its URL, so use the module's first rack as a stable default.
const navigationRackId = computed(() => {
  const requested = Number(route.query.rack);
  if (requested && module.value?.racks?.some((rack) => rack.id === requested)) return requested;
  return module.value?.racks?.[0]?.id ?? null;
});
const modulesInNavigationRack = computed(() => {
  if (!navigationRackId.value) return [];
  return rackModules.value.filter((candidate) =>
    candidate.racks?.some((rack) => rack.id === navigationRackId.value)
  );
});
const nextModule = computed(() => {
  const index = modulesInNavigationRack.value.findIndex(
    (candidate) => candidate.id === Number(props.id)
  );
  return index < 0 ? null : modulesInNavigationRack.value[index + 1] ?? null;
});
const previousModule = computed(() => {
  const index = modulesInNavigationRack.value.findIndex(
    (candidate) => candidate.id === Number(props.id)
  );
  return index <= 0 ? null : modulesInNavigationRack.value[index - 1] ?? null;
});
const modulesHref = computed(() =>
  navigationRackId.value ? `/modules?rack=${navigationRackId.value}` : '/modules'
);
const previousModuleHref = computed(() =>
  previousModule.value
    ? `/modules/${previousModule.value.id}?rack=${navigationRackId.value}`
    : null
);
const nextModuleHref = computed(() =>
  nextModule.value
    ? `/modules/${nextModule.value.id}?rack=${navigationRackId.value}`
    : null
);

const expanderCandidates = computed(() =>
  rackModules.value.filter(
    (m) =>
      m.id !== Number(props.id) &&
      !(module.value?.expanders || []).some((e) => e.module_id === m.id)
  )
);

// The other half of a dual may be a separate module record — or this same
// record racked twice, which the section offers on its own.
const bridgeCandidates = computed(() =>
  rackModules.value.filter(
    (m) =>
      m.id !== Number(props.id) &&
      !(module.value?.bridges || []).some((b) => b.module_id === m.id)
  )
);

// ---- reclassifying components ----
// The analysis sometimes types a mult's jacks as plain inputs/outputs; any
// user with the module racked can correct a component's type and, for
// bidirectional (mult) jacks, its group.
const editingComponentId = ref(null);
const editName = ref('');
const editDescription = ref('');
const editType = ref('');
const editGroup = ref('');
const editPortKind = ref('');
const editError = ref('');
const componentNameDraft = ref('');
const componentTypeDraft = ref('input_jack');
const componentError = ref('');
const componentNotice = ref('');
const addingComponent = ref(false);
const addingToType = ref(null);
const arrangedComponentId = ref(null);

const arrangedComponent = computed(() =>
  (module.value?.components || []).find((c) => c.id === arrangedComponentId.value) || null
);

// A marker whose stored position falls outside the front plate. Positions are
// fractions of the WHOLE image and the plate is the crop within it, so a
// re-crop (or a bad guess from the analysis) can leave one off the picture
// altogether — drawn pinned to an edge, or not drawn at all in the diagram
// and the rack rows, and in no case where the hardware is.
const outOfFrame = (panel, placement) => {
  const { fx, fy } = placementFraction(panel, placement);
  return !(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1);
};

async function arrangeComponent(c) {
  if (arrangedComponentId.value === c.id) {
    arrangedComponentId.value = null;
    return;
  }
  componentError.value = '';
  componentTypeDraft.value = c.type;
  try {
    const placement = (module.value?.panel?.components || []).find(
      (row) => row.component_id === c.id
    );
    if (module.value?.panel && !placement) {
      const { panel } = await api.post(`/api/modules/${props.id}/panel/components`, {
        component_id: c.id,
      });
      if (panel && module.value) module.value = { ...module.value, panel };
    } else if (module.value?.panel && outOfFrame(module.value.panel, placement)) {
      // Arranging is how a marker is put right, so it has to start somewhere
      // it can be taken hold of: the middle of the plate, to be dragged onto
      // the hardware it names from there.
      const crop = module.value.panel.crop || {};
      await movePanelMarker({
        id: placement.id,
        name: placement.name,
        x: (crop.x ?? 0) + (crop.w || 1) / 2,
        y: (crop.y ?? 0) + (crop.h || 1) / 2,
      });
    }
    arrangedComponentId.value = c.id;
    // Arranging happens at the picture: bring it into view so the marker can
    // be dragged without hunting for it.
    scrollToPanel();
  } catch (e) {
    componentError.value = e.message;
  }
}

function showAllPanelComponents() {
  arrangedComponentId.value = null;
}

const panelSection = ref(null);

function scrollToPanel() {
  const el = panelSection.value;
  if (!el) return;
  el.open = true;
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

// A click on a marker jumps back down to that component's row in the list —
// where its Arrange button and everything else about it live.
function scrollToComponentRow({ component_id: componentId }) {
  const button =
    document.querySelector(`[data-test="arrange-component-${componentId}"]`) ||
    document.querySelector(`[data-test="edit-component-${componentId}"]`);
  if (!button) return;
  const group = button.closest('details');
  if (group) group.open = true;
  (button.closest('tr') || button).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

function startEditComponent(c) {
  editingComponentId.value = c.id;
  editName.value = c.name;
  editDescription.value = c.description || '';
  editType.value = c.type;
  editGroup.value = c.group_label || '';
  editPortKind.value = c.port_kind || '';
  editError.value = '';
}

async function saveComponent(c) {
  editError.value = '';
  try {
    await api.put(`/api/modules/${props.id}/components/${c.id}`, {
      name: editName.value,
      description: editDescription.value,
      type: editType.value,
      group_label: editGroup.value,
      port_kind: editPortKind.value,
    });
    editingComponentId.value = null;
    await load();
  } catch (e) {
    editError.value = e.message;
  }
}

// Manual analysis is only a starting inventory. Missing patch points and
// controls can be added here, and the API gives each one a panel placement
// immediately when a panel exists so diagrams can use it on refresh.
async function addComponent() {
  componentError.value = '';
  componentNotice.value = '';
  addingComponent.value = true;
  try {
    const component = await api.post(`/api/modules/${props.id}/components`, {
      name: componentNameDraft.value.trim(),
      type: componentTypeDraft.value,
    });
    componentNameDraft.value = '';
    addingToType.value = null;
    if (component.panel_placement_id) {
      componentNotice.value =
        'Panel marker added — drag it onto the correct position if needed.';
    }
    await load();
  } catch (e) {
    componentError.value = e.message;
  } finally {
    addingComponent.value = false;
  }
}

function startAddingComponent(type, event) {
  componentTypeDraft.value = type;
  componentNameDraft.value = '';
  componentError.value = '';
  componentNotice.value = '';
  addingToType.value = type;
  const details = event?.currentTarget?.closest('details');
  if (details) details.open = true;
}

function cancelAddingComponent() {
  componentNameDraft.value = '';
  addingToType.value = null;
}

async function removeComponent(c) {
  const ok = await dialog.confirm({
    title: 'Remove component',
    message: `Remove ${c.name} from this module? Its panel marker and related signal-path data will also be removed.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  componentTypeDraft.value = c.type;
  componentError.value = '';
  componentNotice.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/components/${c.id}`);
    if (editingComponentId.value === c.id) editingComponentId.value = null;
    if (arrangedComponentId.value === c.id) arrangedComponentId.value = null;
    await load();
  } catch (e) {
    componentError.value = e.message;
  }
}

// "0 … 10" for a min/max range, "LP | BP | HP" for enum positions.
function valueSummary(c) {
  const values = c.values || [];
  const options = values.filter((v) => v.type === 'enum').map((v) => v.value);
  if (options.length > 0) return options.join(' | ');
  const min = values.find((v) => v.type === 'min')?.value;
  const max = values.find((v) => v.type === 'max')?.value;
  if (min === undefined && max === undefined) return '—';
  return `${min ?? '?'} … ${max ?? '?'}`;
}

function voltageRange(c) {
  if (c.voltage_min === null && c.voltage_max === null) return '—';
  const min = c.voltage_min === null ? '?' : `${c.voltage_min}V`;
  const max = c.voltage_max === null ? '?' : `${c.voltage_max}V`;
  return `${min} … ${max}`;
}

async function load() {
  try {
    const loaded = await api.get(`/api/modules/${props.id}`);
    module.value = loaded;
    // The width beside panel import is an override, but the most useful
    // starting value is what manual analysis (or a previous import) already
    // established for the module. Do not wipe out an edit merely because an
    // unrelated action refreshed the detail page.
    if (!panelHpDirty.value) panelHp.value = loaded.hp == null ? '' : String(loaded.hp);
  } catch (e) {
    error.value = e.message;
  }
  // Candidates for an expander link: the other modules in your racks.
  try {
    const list = await api.get('/api/modules', { quiet: true });
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
}

// ---- front panel ----
// The app finds or draws a panel by itself, but the picture it ends up with
// can be the wrong module, or a diagram where a photograph exists. Supplying
// one replaces it for good: the panel job stops researching and instead
// locates this module's components on the picture supplied here.
const panelHp = ref('');
const panelHpDirty = ref(false);
const panelUrl = ref('');
const panelError = ref('');
const panelUploading = ref(false);

function panelHpField(body) {
  const hp = panelHp.value.trim();
  if (hp) body.hp = hp;
  return body;
}

async function uploadPanel(file) {
  panelError.value = '';
  panelUploading.value = true;
  try {
    const data_base64 = await fileToBase64(file);
    const body = panelHpField({ filename: file.name, data_base64 });
    await api.post(`/api/modules/${props.id}/panel`, body);
    panelHpDirty.value = false;
    await load();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    panelUploading.value = false;
  }
}

async function downloadPanel() {
  const url = panelUrl.value.trim();
  if (!url) return;
  panelError.value = '';
  panelUploading.value = true;
  try {
    await api.post(`/api/modules/${props.id}/panel`, panelHpField({ url }));
    panelUrl.value = '';
    panelHpDirty.value = false;
    await load();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    panelUploading.value = false;
  }
}

async function onPanelChosen(event) {
  const file = event.target.files?.[0];
  if (file) await uploadPanel(file);
  event.target.value = '';
}

// A marker dragged onto the hardware it names. Saved where it was dropped:
// the position is only ever an estimate, and someone looking at the picture
// has better evidence than the estimate did. The panel comes back from the
// save so the marker settles on exactly what was stored rather than on where
// the pointer happened to be.
const panelStatus = ref('');

// Cut the blank backdrop away from the panel picture. The server cuts the
// image file down to the front plate and re-bases every marker onto it, so
// the markers keep pointing at the same hardware and the picture on its own
// is the panel. It can only be done once — afterwards there is no backdrop
// left to find.
const trimmingPanel = ref(false);
async function trimPanel() {
  panelError.value = '';
  panelStatus.value = '';
  trimmingPanel.value = true;
  try {
    const { panel } = await api.post(`/api/modules/${props.id}/panel/trim`);
    if (panel && module.value) module.value = { ...module.value, panel };
    panelStatus.value = 'Cut the picture down to the front plate.';
  } catch (e) {
    panelError.value = e.message;
  } finally {
    trimmingPanel.value = false;
  }
}

async function movePanelMarker({ id, name, x, y }) {
  panelError.value = '';
  panelStatus.value = '';
  try {
    const { panel } = await api.patch(`/api/modules/${props.id}/panel/components/${id}`, { x, y });
    if (panel && module.value) module.value = { ...module.value, panel };
    panelStatus.value = `Moved ${name}.`;
  } catch (e) {
    panelError.value = e.message;
    // The save failed, so the marker must go back to where it really is
    // rather than sit where it was dropped.
    await load();
  }
}

async function removePanel() {
  const ok = await dialog.confirm({
    title: 'Remove panel image',
    message:
      'Discard the uploaded picture? The app will go back to finding or drawing a panel for this module.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  panelError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/panel`);
    await load();
  } catch (e) {
    panelError.value = e.message;
  }
}

onMounted(load);
watch(() => props.id, () => {
  panelHp.value = '';
  panelHpDirty.value = false;
  arrangedComponentId.value = null;
  load();
});
</script>

<template>
  <nav class="module-detail-navigation" aria-label="Module navigation">
    <span>
      <RouterLink v-if="previousModule" :to="previousModuleHref" data-test="previous-module">
        ← Previous Module
      </RouterLink>
    </span>
    <RouterLink :to="modulesHref">← All modules</RouterLink>
    <span>
      <RouterLink v-if="nextModule" :to="nextModuleHref" data-test="next-module">
        Next Module →
      </RouterLink>
    </span>
  </nav>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="module">
    <div v-if="editingNaming" class="row reanalyze-row" data-test="edit-naming">
      <input
        v-model="editManufacturer"
        aria-label="Manufacturer"
        placeholder="Manufacturer"
        style="flex: 0 0 auto; width: 13rem"
        data-test="edit-manufacturer"
      />
      <input
        v-model="editModuleName"
        aria-label="Module name"
        placeholder="Module name"
        style="flex: 0 0 auto; width: 13rem"
        data-test="edit-module-name"
      />
      <input
        v-model="editHp"
        aria-label="Width in HP"
        placeholder="HP"
        style="flex: 0 0 auto; width: 4.5rem"
        title="Width in HP — leave empty if unknown"
        data-test="edit-hp"
      />
      <button style="margin: 0" :disabled="savingNaming" data-test="save-naming" @click="saveNaming">
        {{ savingNaming ? 'Saving…' : 'Save' }}
      </button>
      <button style="margin: 0" class="secondary" data-test="cancel-naming" @click="editingNaming = false">
        Cancel
      </button>
    </div>
    <h1 v-else>
      {{ module.manufacturer }} {{ module.name }}
      <button
        class="linklike"
        style="font-size: 1rem; vertical-align: middle"
        title="Correct the manufacturer, module name or HP without re-analysis (the fix shows for every user of this module)"
        data-test="edit-naming-button"
        @click="startEditNaming"
      >
        Edit
      </button>
    </h1>
    <p v-if="namingError" class="error" data-test="naming-error">{{ namingError }}</p>
    <p>
      <span class="badge" :class="module.manual_status">manual: {{ module.manual_status }}</span>
      &nbsp;
      <span class="badge" :class="module.analysis_status">
        analysis: {{ module.analysis_status }}
      </span>
      &nbsp;
      <span class="badge" :class="module.panel_status">panel: {{ module.panel_status }}</span>
      <template v-if="module.hp">
        &nbsp;
        <span class="badge" data-test="module-hp">{{ module.hp }}HP</span>
      </template>
    </p>
    <div v-if="editingQuantities" class="row reanalyze-row" data-test="edit-quantities">
      <label v-for="r in module.racks" :key="r.id" style="flex: 0 0 auto">
        {{ r.name }} ×
        <input
          v-model="editQuantities[r.id]"
          :aria-label="`Quantity in ${r.name}`"
          style="width: 4rem"
          :data-test="`edit-quantity-${r.id}`"
        />
      </label>
      <button
        style="margin: 0"
        :disabled="savingQuantities"
        data-test="save-quantities"
        @click="saveQuantities"
      >
        {{ savingQuantities ? 'Saving…' : 'Save' }}
      </button>
      <button
        style="margin: 0"
        class="secondary"
        data-test="cancel-quantities"
        @click="editingQuantities = false"
      >
        Cancel
      </button>
    </div>
    <p v-else-if="module.racks?.length" data-test="racks">
      In {{ module.racks.length === 1 ? 'rack' : 'racks' }}:
      {{ module.racks.map((r) => `${r.name} (×${r.quantity})`).join(', ') }}
      <button
        class="linklike"
        title="Change how many copies of this module each rack contains"
        data-test="edit-quantities-button"
        @click="startEditQuantities"
      >
        Edit
      </button>
      — <RouterLink to="/racks">manage racks</RouterLink>
    </p>
    <p v-if="quantityError" class="error" data-test="quantity-error">{{ quantityError }}</p>

    <div class="row reanalyze-row">
      <button
        style="margin: 0; white-space: nowrap"
        :disabled="reanalyzing || retailerPagesExist"
        :title="reanalyzeTitle"
        data-test="reanalyze-components"
        @click="reanalyzeComponents"
      >
        {{ reanalyzing ? 'Queuing…' : 'Re-analyze components' }}
      </button>
      <button
        style="margin: 0; white-space: nowrap"
        :disabled="rebuilding"
        :title="rebuildTitle"
        data-test="rebuild-analysis"
        @click="rebuildAnalysis"
      >
        {{ rebuilding ? 'Queuing…' : 'Rebuild analysis' }}
      </button>
      <button
        v-if="module.panel && ['upload', 'image'].includes(module.panel.source)"
        type="button"
        class="secondary"
        style="margin: 0; white-space: nowrap"
        data-test="panel-trim"
        :disabled="trimmingPanel || module.panel.trimmed"
        :title="
          module.panel.trimmed
            ? 'This picture has already been cut down to the front plate'
            : 'Cut the picture down to the front plate — the markers stay on the hardware they point at'
        "
        @click="trimPanel"
      >
        {{ trimmingPanel ? 'Trimming…' : module.panel.trimmed ? 'Panel trimmed' : 'Trim panel' }}
      </button>
      <button
        v-if="module.panel"
        type="button"
        class="secondary"
        style="margin: 0; white-space: nowrap"
        data-test="panel-disable-arranging"
        :disabled="!arrangedComponent"
        :title="
          arrangedComponent
            ? `Show every marker again — only ${arrangedComponent.name} is on the picture right now`
            : 'Nothing is being arranged — press Arrange on a component row to isolate its marker on the picture'
        "
        @click="showAllPanelComponents"
      >
        Disable arranging
      </button>
    </div>
    <p v-if="reanalyzeNotice" class="muted" data-test="reanalyze-notice">{{ reanalyzeNotice }}</p>
    <p v-if="reanalyzeError" class="error" data-test="reanalyze-error">{{ reanalyzeError }}</p>
    <p v-if="rebuildNotice" class="muted" data-test="rebuild-notice">{{ rebuildNotice }}</p>
    <p v-if="rebuildError" class="error" data-test="rebuild-error">{{ rebuildError }}</p>

    <details ref="panelSection" open class="panel" data-test="panel">
      <summary>
        <h2>Front panel</h2>
        <span class="summary-count">
          <template v-if="module.panel">{{ module.panel.components.length }} placed</template>
          <template v-else>none yet</template>
        </span>
      </summary>
      <div class="panel-body">
        <ModulePanel
          v-if="module.panel"
          :panel="module.panel"
          :only-component-id="arrangedComponentId"
          editable
          @move="movePanelMarker"
          @select="scrollToComponentRow"
        />
        <!-- Trim panel and Disable arranging act on this picture but sit in
             the action row at the top of the page, beside the re-analyze
             buttons, so every module-wide action is in one place. -->
        <div
          v-if="arrangedComponent"
          class="panel-arrangement-filter"
          data-test="panel-arrangement-filter"
        >
          <span>Arranging only <strong>{{ arrangedComponent.name }}</strong>.</span>
        </div>
        <p v-if="panelStatus" class="muted" data-test="panel-status">{{ panelStatus }}</p>
        <p v-else class="muted" data-test="no-panel">
          No panel picture yet — the app builds one once the manual has been analyzed, or you can
          supply your own below.
        </p>

        <label for="panel-upload">
          Supply your own panel picture (PNG, JPEG, GIF or WebP, up to 12MB)
        </label>
        <p class="muted" style="margin-top: 0">
          Upload a file or enter a direct image URL. A straight-on shot of the front plate works
          best. Leave the width blank and it is measured off the picture — a shot that takes in an
          expander sets the module's width to what it actually shows, so the rack is not drawn
          stretched. The components are located on it in the background, so the markers appear once
          that job finishes. Everyone with this module in a rack sees the picture you supply.
        </p>
        <div class="row">
          <input
            id="panel-hp"
            v-model="panelHp"
            style="max-width: 10rem"
            placeholder="Width in HP (optional)"
            data-test="panel-hp"
            @input="panelHpDirty = true"
          />
          <input
            id="panel-upload"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            data-test="panel-upload"
            :disabled="panelUploading"
            @change="onPanelChosen"
          />
          <input
            v-model="panelUrl"
            type="url"
            style="min-width: min(28rem, 100%)"
            placeholder="https://example.com/panel.png"
            aria-label="Panel image URL"
            data-test="panel-url"
            :disabled="panelUploading"
            @keyup.enter="downloadPanel"
          />
          <button
            type="button"
            data-test="panel-url-submit"
            :disabled="panelUploading || !panelUrl.trim()"
            @click="downloadPanel"
          >
            Download from URL
          </button>
          <button
            v-if="module.panel?.source === 'upload'"
            class="danger"
            data-test="remove-panel"
            @click="removePanel"
          >
            Remove supplied picture
          </button>
        </div>
        <p v-if="panelError" class="error" data-test="panel-error">{{ panelError }}</p>
      </div>
    </details>

    <details v-if="module.summary" open class="panel" data-test="summary">
      <summary>
        <h2>Summary</h2>
      </summary>
      <div class="panel-body">
        <p style="white-space: pre-wrap">{{ module.summary }}</p>
      </div>
    </details>

    <NormalizationsSection :module="module" :module-id="id" @reload="load" />
    <SwitchesSection :module="module" :module-id="id" @reload="load" />
    <RoutesSection :module="module" :module-id="id" @reload="load" />
    <PairsSection :module="module" :module-id="id" @reload="load" />
    <ExpandersSection
      :module="module"
      :module-id="id"
      :candidates="expanderCandidates"
      @reload="load"
    />
    <BridgesSection
      :module="module"
      :module-id="id"
      :candidates="bridgeCandidates"
      @reload="load"
    />
    <ValuesSection :module="module" :module-id="id" @reload="load" />
    <DocumentsSection :module="module" :module-id="id" @reload="load" />
    <VideosSection :module="module" :module-id="id" @reload="load" />
    <NotesSection :module="module" :module-id="id" @reload="load" />

    <details v-for="group in grouped" :key="group.type" class="panel" :data-test="`group-${group.type}`">
      <summary>
        <!-- The colour this type is drawn in on every panel picture, so the
             list and the markers on the plate read as the same thing. -->
        <span
          class="type-swatch"
          :style="{ background: componentColor(group.type) }"
          :data-test="`type-swatch-${group.type}`"
          aria-hidden="true"
        ></span>
        <h2>{{ group.label }}</h2>
        <span class="summary-count">{{ group.components.length }}</span>
        <button
          type="button"
          class="secondary group-add-button"
          :data-test="`add-new-${group.type}`"
          @click.prevent.stop="startAddingComponent(group.type, $event)"
        >
          + Add new
        </button>
      </summary>
      <div class="panel-body">
        <form
          v-if="addingToType === group.type"
          class="component-add-form"
          :data-test="`add-form-${group.type}`"
          @submit.prevent="addComponent"
        >
          <label :for="`new-component-${group.type}`">New {{ singularLabel(group) }} name</label>
          <div class="component-add-row">
            <input
              :id="`new-component-${group.type}`"
              v-model="componentNameDraft"
              placeholder="Component name"
              data-test="component-name"
              autofocus
            />
            <button
              type="submit"
              :disabled="addingComponent || !componentNameDraft.trim()"
              data-test="component-add"
            >
              Add
            </button>
            <button type="button" class="secondary" @click="cancelAddingComponent">Cancel</button>
          </div>
        </form>
        <p
          v-if="componentError && componentTypeDraft === group.type"
          class="error"
          data-test="component-error"
        >
          {{ componentError }}
        </p>
        <p
          v-if="componentNotice && componentTypeDraft === group.type"
          class="muted"
          data-test="component-notice"
        >
          {{ componentNotice }}
        </p>
        <div v-if="group.components.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th v-if="group.type.endsWith('_jack')">Connector</th>
                <th v-if="group.type.endsWith('_jack')">Voltage range</th>
                <th v-if="group.type.endsWith('_jack')">Polarity</th>
                <th v-if="group.type === 'bidirectional_jack'">Group</th>
                <th v-if="group.type === 'output_jack'">Signal</th>
                <th v-if="!group.type.endsWith('_jack')">Valid values</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in group.components" :key="c.id">
                <td>
                  <input
                    v-if="editingComponentId === c.id"
                    v-model="editName"
                    placeholder="Name"
                    :data-test="`edit-name-${c.id}`"
                  />
                  <template v-else>{{ c.name }}</template>
                </td>
                <td>
                  <input
                    v-if="editingComponentId === c.id"
                    v-model="editDescription"
                    placeholder="Description"
                    :data-test="`edit-description-${c.id}`"
                  />
                  <template v-else>{{ c.description || '—' }}</template>
                </td>
                <td v-if="group.type.endsWith('_jack')">{{ portKindLabel(c.port_kind) }}</td>
                <td v-if="group.type.endsWith('_jack')">{{ voltageRange(c) }}</td>
                <td v-if="group.type.endsWith('_jack')">{{ c.polarity || '—' }}</td>
                <td v-if="group.type === 'bidirectional_jack'">{{ c.group_label || '—' }}</td>
                <td v-if="group.type === 'output_jack'">{{ outputSignalSource(c) }}</td>
                <td v-if="!group.type.endsWith('_jack')">{{ valueSummary(c) }}</td>
                <td class="component-actions-cell">
                  <div v-if="editingComponentId === c.id" class="component-edit-actions">
                    <select v-model="editType" :data-test="`edit-type-${c.id}`" style="width: auto">
                      <option v-for="t in COMPONENT_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                    <input
                      v-if="editType === 'bidirectional_jack'"
                      v-model="editGroup"
                      placeholder="Mult group (e.g. 1)"
                      :data-test="`edit-group-${c.id}`"
                      style="width: auto"
                    />
                    <select
                      v-if="editType.endsWith('_jack')"
                      v-model="editPortKind"
                      :data-test="`edit-port-kind-${c.id}`"
                      style="width: auto"
                    >
                      <option value="">3.5mm patch point</option>
                      <option v-for="k in PORT_KINDS" :key="k" :value="k">
                        {{ portKindLabel(k) }}
                      </option>
                    </select>
                    <button
                      :disabled="!editName.trim()"
                      :data-test="`edit-save-${c.id}`"
                      @click="saveComponent(c)"
                    >
                      Save
                    </button>
                    <button @click="editingComponentId = null">Cancel</button>
                  </div>
                  <div v-else class="component-row-actions">
                    <button
                      type="button"
                      class="secondary"
                      :class="{ selected: arrangedComponentId === c.id }"
                      :data-test="`arrange-component-${c.id}`"
                      @click="arrangeComponent(c)"
                    >
                      {{ arrangedComponentId === c.id ? 'Arranging' : 'Arrange' }}
                    </button>
                    <button
                      :data-test="`edit-component-${c.id}`"
                      @click="startEditComponent(c)"
                    >
                      Edit
                    </button>
                    <button
                      class="danger"
                      :data-test="`remove-component-${c.id}`"
                      @click="removeComponent(c)"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else-if="addingToType !== group.type" class="muted">
          No {{ group.label.toLowerCase() }} yet.
        </p>
        <p
          v-if="editError && group.components.some((c) => c.id === editingComponentId)"
          class="error"
          data-test="edit-error"
        >
          {{ editError }}
        </p>
      </div>
    </details>

    <p v-if="module.components && module.components.length === 0" class="muted">
      No components yet — the manual hasn't been analyzed.
    </p>
  </template>
</template>
