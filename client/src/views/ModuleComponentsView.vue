<script setup>
// Everything on the front plate, listed by what kind of thing it is. The
// panel picture is here too, but only while a marker is being arranged: this
// is the page where a component is named, retyped, removed and put in its
// place on the plate, and arranging is the one of those that needs to see
// the hardware.
import { computed, nextTick, ref, toRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { COMPONENT_TYPES, TYPE_LABELS, componentColor } from '../componentTypes.js';
import { dialog } from '../dialog.js';
import ModulePanel from '../components/ModulePanel.vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import { useModuleFacts } from '../components/moduledetail/useModuleFacts.js';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';
import { useArranging } from '../components/moduledetail/useArranging.js';

const props = defineProps({ id: { type: String, required: true } });

const route = useRoute();
const id = toRef(props, 'id');
const { module, error, rackModules, load } = useModuleRecord(id);
const { componentName } = useModuleFacts(module);

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
// The same arranging mode the module page and the jack pages are in — one
// component picked, only its marker on the plate, dragged onto the hardware
// it names (moduledetail/useArranging.js).
const {
  arrangedComponentId,
  arrangedComponent,
  arrange,
  stopArranging,
  arrangeError,
  movePanelMarker,
  panelError,
  panelStatus,
} = useArranging(module, id, load);

async function arrangeComponent(c) {
  componentError.value = '';
  componentTypeDraft.value = c.type;
  // Arranging happens at the picture, which is drawn at the top of this page
  // only while it is going on: bring it into view so the marker can be
  // dragged without hunting for it.
  await arrange(c, { onArranged: scrollToPanel });
  // A refused arrange is reported where this page reports everything else
  // about a component: beside the group the row is in.
  if (arrangeError.value) componentError.value = arrangeError.value;
}

const showAllPanelComponents = stopArranging;

const panelSection = ref(null);

function scrollToPanel() {
  panelSection.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
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

// A marker clicked on the module's own page sends the reader here to arrange
// exactly that component, so the picture and the row open together.
async function arrangeFromQuery() {
  const wanted = Number(route.query.arrange);
  if (!wanted || arrangedComponentId.value === wanted) return;
  const component = (module.value?.components || []).find((c) => c.id === wanted);
  if (!component) return;
  await arrangeComponent(component);
  await nextTick();
  scrollToComponentRow({ component_id: wanted });
}
watch(module, arrangeFromQuery);

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

watch(id, () => {
  arrangedComponentId.value = null;
});
</script>

<template>
  <ModuleDetailHeader
    :module="module"
    :module-id="id"
    :rack-modules="rackModules"
    :error="error"
    @reload="load"
  />
  <template v-if="module">
    <!-- The plate, for as long as a marker is being put right on it. -->
    <div
      v-if="arrangedComponent && module.panel"
      ref="panelSection"
      class="panel arrange-panel"
      data-test="arrange-panel"
    >
      <ModulePanel
        :panel="module.panel"
        :only-component-id="arrangedComponentId"
        editable
        @move="movePanelMarker"
        @select="scrollToComponentRow"
      />
      <div class="panel-arrangement-filter" data-test="panel-arrangement-filter">
        <span>
          Arranging only <strong>{{ arrangedComponent.name }}</strong> — drag the marker onto the
          hardware it names.
        </span>
        <button
          type="button"
          class="secondary"
          data-test="panel-disable-arranging"
          @click="showAllPanelComponents"
        >
          Done
        </button>
      </div>
      <p v-if="panelStatus" class="muted" data-test="panel-status">{{ panelStatus }}</p>
      <p v-if="panelError" class="error" data-test="panel-error">{{ panelError }}</p>
    </div>

    <details
      v-for="group in grouped"
      :key="group.type"
      class="panel"
      :data-test="`group-${group.type}`"
    >
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
                      :disabled="!module.panel"
                      :title="
                        module.panel
                          ? 'Show only this marker on the front plate and drag it into place'
                          : 'There is no panel picture to arrange this marker on yet'
                      "
                      :data-test="`arrange-component-${c.id}`"
                      @click="arrangeComponent(c)"
                    >
                      {{ arrangedComponentId === c.id ? 'Arranging' : 'Arrange' }}
                    </button>
                    <button :data-test="`edit-component-${c.id}`" @click="startEditComponent(c)">
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
