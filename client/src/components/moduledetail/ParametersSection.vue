<script setup>
// The module's MENU: everything you can set on it that has no control of its
// own.
//
// A filter's LP/BP/HP switch is a component with three positions and the
// Component values page says so. Pamela's Pro Workout has one encoder, one
// screen and eight output jacks, and every output's clock division, waveform,
// level and pulse width is chosen by turning that encoder through a menu.
// None of those is a thing on the panel, a dozen of them belong to a single
// jack, and until they are recorded here a patch of the module says nothing
// about what it was actually doing.
//
// Each parameter hangs off the component it configures — usually an output
// jack — or off nothing at all when it belongs to the whole module, and
// carries the list of settings to choose between. That list is what turns
// dialling in a patch into picking from a menu rather than typing a guess.

import { computed, reactive, ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { toast } from '../../toast.js';
import { typeLabel } from '../../componentTypes.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const VALUE_TYPES = [
  { value: 'enum', label: 'one of a list' },
  { value: 'number', label: 'a number in a range' },
  { value: 'text', label: 'free text' },
];

const error = ref('');
const finding = ref(false);

const componentsById = computed(
  () => new Map((props.module?.components || []).map((c) => [c.id, c]))
);
const parameters = computed(() => props.module?.parameters || []);

// Grouped by the component they configure, because that is how they are read:
// "what can I set on OUT 1" rather than "what parameters does this module
// have". The module-wide ones come first — they are the module's own state,
// not any one jack's.
const groups = computed(() => {
  const byComponent = new Map();
  for (const p of parameters.value) {
    const key = p.component_id ?? 0;
    if (!byComponent.has(key)) byComponent.set(key, []);
    byComponent.get(key).push(p);
  }
  const rows = [...byComponent.entries()].map(([key, rows_]) => {
    const component = key === 0 ? null : componentsById.value.get(key);
    return {
      key,
      component,
      title: component ? component.name : 'The module itself',
      subtitle: component ? typeLabel(component.type) : 'settings that belong to no single jack',
      parameters: rows_,
    };
  });
  return rows.sort(
    (a, b) => (a.key === 0 ? -1 : 0) - (b.key === 0 ? -1 : 0) || String(a.title).localeCompare(String(b.title))
  );
});

const optionsOf = (parameter) => parameter.options || [];

// ---- reading the menu out of the documents ----

async function findParameters() {
  error.value = '';
  finding.value = true;
  try {
    await api.post(`/api/modules/${props.moduleId}/parameters/find`, {});
    toast.info(`Reading this module’s menu — the parameters appear as they are found.`);
  } catch (e) {
    error.value = e.message;
  } finally {
    finding.value = false;
  }
}

// ---- adding one by hand ----

const draft = reactive({
  name: '',
  component_id: '',
  group_label: '',
  value_type: 'enum',
  unit: '',
  value_min: '',
  value_max: '',
  default_value: '',
  description: '',
});
const canCreate = computed(() => draft.name.trim() !== '');

async function createParameter() {
  error.value = '';
  try {
    await api.post(`/api/modules/${props.moduleId}/parameters`, {
      name: draft.name.trim(),
      component_id: draft.component_id === '' ? null : Number(draft.component_id),
      group_label: draft.group_label.trim(),
      value_type: draft.value_type,
      unit: draft.unit.trim(),
      value_min: draft.value_min.trim(),
      value_max: draft.value_max.trim(),
      default_value: draft.default_value.trim(),
      description: draft.description.trim(),
    });
    draft.name = '';
    draft.group_label = '';
    draft.unit = '';
    draft.value_min = '';
    draft.value_max = '';
    draft.default_value = '';
    draft.description = '';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

// ---- correcting one ----

const editingId = ref(null);
const edit = reactive({ name: '', component_id: '', value_type: 'enum', unit: '', value_min: '', value_max: '', default_value: '', description: '' });

function startEdit(parameter) {
  editingId.value = parameter.id;
  edit.name = parameter.name;
  edit.component_id = parameter.component_id == null ? '' : String(parameter.component_id);
  edit.value_type = parameter.value_type;
  edit.unit = parameter.unit || '';
  edit.value_min = parameter.value_min || '';
  edit.value_max = parameter.value_max || '';
  edit.default_value = parameter.default_value || '';
  edit.description = parameter.description || '';
  error.value = '';
}

async function saveEdit(parameter) {
  error.value = '';
  try {
    await api.put(`/api/modules/${props.moduleId}/parameters/${parameter.id}`, {
      name: edit.name.trim(),
      component_id: edit.component_id === '' ? null : Number(edit.component_id),
      value_type: edit.value_type,
      unit: edit.unit.trim(),
      value_min: edit.value_min.trim(),
      value_max: edit.value_max.trim(),
      default_value: edit.default_value.trim(),
      description: edit.description.trim(),
    });
    editingId.value = null;
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

async function removeParameter(parameter) {
  const ok = await dialog.confirm({
    title: 'Remove parameter',
    message: `Remove the '${parameter.name}' menu parameter? Values already recorded for it in a patch keep their name and lose the link.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/parameters/${parameter.id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

// ---- the settings a parameter offers ----

const optionDraft = reactive({});
const optionKey = (parameter) => `p${parameter.id}`;

function optionValue(parameter) {
  const key = optionKey(parameter);
  if (!(key in optionDraft)) optionDraft[key] = { value: '', description: '' };
  return key;
}

async function addOption(parameter) {
  const key = optionKey(parameter);
  const entry = optionDraft[key];
  if (!entry?.value.trim()) return;
  error.value = '';
  try {
    await api.post(`/api/modules/${props.moduleId}/parameters/${parameter.id}/options`, {
      value: entry.value.trim(),
      description: entry.description.trim(),
    });
    optionDraft[key] = { value: '', description: '' };
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}

async function removeOption(parameter, option) {
  error.value = '';
  try {
    await api.delete(
      `/api/modules/${props.moduleId}/parameters/${parameter.id}/options/${option.id}`
    );
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <details open class="panel" data-test="parameters">
    <summary>
      <h2>Menu parameters</h2>
      <span class="summary-count">
        {{ parameters.length }} {{ parameters.length === 1 ? 'parameter' : 'parameters' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted" style="margin-top: 0">
        The settings this module keeps in a menu rather than under a control of its own — the
        clock division of an output, a global tempo, anything reached by turning an encoder and
        reading a screen. Each one belongs to the jack or control it configures, or to the module
        itself, and carries the settings to choose between; a patch then records which one is
        picked, on its
        <RouterLink :to="`/patches`">settings</RouterLink> page, and every question asked about
        that patch is told about it.
      </p>

      <p>
        <button type="button" :disabled="finding" data-test="find-parameters" @click="findParameters">
          Read the menu from the documents
        </button>
        <span class="muted"> — one model pass that only ever adds; your corrections stay.</span>
      </p>
      <p v-if="error" class="error" data-test="parameters-error">{{ error }}</p>

      <p v-if="parameters.length === 0" class="muted" data-test="parameters-empty">
        No menu parameters recorded. Most modules have none — everything they do is on the panel.
      </p>

      <div v-for="group in groups" :key="group.key" class="parameter-group" :data-test="`parameter-group-${group.key}`">
        <h3>
          {{ group.title }}
          <em class="muted">{{ group.subtitle }}</em>
        </h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Takes</th>
                <th>Settings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="parameter in group.parameters"
                :key="parameter.id"
                :data-test="`parameter-${parameter.id}`"
              >
                <td>
                  <template v-if="editingId === parameter.id">
                    <input v-model="edit.name" :data-test="`edit-parameter-name-${parameter.id}`" />
                    <select v-model="edit.component_id" :data-test="`edit-parameter-component-${parameter.id}`">
                      <option value="">the module itself</option>
                      <option v-for="c in module.components" :key="c.id" :value="String(c.id)">
                        {{ c.name }} ({{ typeLabel(c.type) }})
                      </option>
                    </select>
                    <input
                      v-model="edit.description"
                      placeholder="What this parameter does"
                      :data-test="`edit-parameter-description-${parameter.id}`"
                    />
                  </template>
                  <template v-else>
                    <strong>{{ parameter.name }}</strong>
                    <div v-if="parameter.group_label" class="muted">{{ parameter.group_label }}</div>
                    <div v-if="parameter.description" class="muted">{{ parameter.description }}</div>
                  </template>
                </td>
                <td>
                  <template v-if="editingId === parameter.id">
                    <select v-model="edit.value_type" :data-test="`edit-parameter-type-${parameter.id}`">
                      <option v-for="t in VALUE_TYPES" :key="t.value" :value="t.value">
                        {{ t.label }}
                      </option>
                    </select>
                    <input v-model="edit.value_min" placeholder="min" style="width: 5rem" />
                    <input v-model="edit.value_max" placeholder="max" style="width: 5rem" />
                    <input v-model="edit.unit" placeholder="unit" style="width: 5rem" />
                    <input v-model="edit.default_value" placeholder="default" style="width: 6rem" />
                  </template>
                  <template v-else>
                    {{ VALUE_TYPES.find((t) => t.value === parameter.value_type)?.label || parameter.value_type }}
                    <div v-if="parameter.value_min !== null || parameter.value_max !== null" class="muted">
                      {{ parameter.value_min ?? '?' }} … {{ parameter.value_max ?? '?' }}
                      {{ parameter.unit || '' }}
                    </div>
                    <div v-if="parameter.default_value" class="muted">
                      default {{ parameter.default_value }}
                    </div>
                  </template>
                </td>
                <td>
                  <ul v-if="optionsOf(parameter).length" class="option-list">
                    <li
                      v-for="option in optionsOf(parameter)"
                      :key="option.id"
                      :data-test="`parameter-option-${option.id}`"
                    >
                      <strong>{{ option.value }}</strong>
                      <span v-if="option.description" class="muted"> — {{ option.description }}</span>
                      <button
                        type="button"
                        class="danger"
                        :data-test="`delete-option-${option.id}`"
                        @click="removeOption(parameter, option)"
                      >
                        ×
                      </button>
                    </li>
                  </ul>
                  <p v-else class="muted">
                    No settings listed — a value is typed rather than picked until there are.
                  </p>
                  <form class="option-add" @submit.prevent="addOption(parameter)">
                    <input
                      v-model="optionDraft[optionValue(parameter)].value"
                      placeholder="Add a setting"
                      :data-test="`option-value-${parameter.id}`"
                    />
                    <input
                      v-model="optionDraft[optionValue(parameter)].description"
                      placeholder="What it does (optional)"
                      :data-test="`option-description-${parameter.id}`"
                    />
                    <button type="submit" :data-test="`option-add-${parameter.id}`">Add</button>
                  </form>
                </td>
                <td class="actions-cell">
                  <div class="actions nowrap">
                    <template v-if="editingId === parameter.id">
                      <button :data-test="`save-parameter-${parameter.id}`" @click="saveEdit(parameter)">
                        Save
                      </button>
                      <button class="secondary" @click="editingId = null">Cancel</button>
                    </template>
                    <template v-else>
                      <button :data-test="`edit-parameter-${parameter.id}`" @click="startEdit(parameter)">
                        Edit
                      </button>
                      <button
                        class="danger"
                        :data-test="`delete-parameter-${parameter.id}`"
                        @click="removeParameter(parameter)"
                      >
                        Remove
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <form data-test="parameter-create-form" @submit.prevent="createParameter">
        <h3>Add a parameter</h3>
        <div class="row">
          <div>
            <label for="parameter-name">Name</label>
            <input id="parameter-name" v-model="draft.name" data-test="parameter-name" placeholder="e.g. Clock division" />
          </div>
          <div>
            <label for="parameter-component">Belongs to</label>
            <select id="parameter-component" v-model="draft.component_id" data-test="parameter-component">
              <option value="">the module itself</option>
              <option v-for="c in module.components" :key="c.id" :value="String(c.id)">
                {{ c.name }} ({{ typeLabel(c.type) }})
              </option>
            </select>
          </div>
          <div class="shrink">
            <label for="parameter-type">Takes</label>
            <select id="parameter-type" v-model="draft.value_type" data-test="parameter-type">
              <option v-for="t in VALUE_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </div>
          <div class="shrink">
            <label for="parameter-min">Min</label>
            <input id="parameter-min" v-model="draft.value_min" data-test="parameter-min" />
          </div>
          <div class="shrink">
            <label for="parameter-max">Max</label>
            <input id="parameter-max" v-model="draft.value_max" data-test="parameter-max" />
          </div>
          <div class="shrink">
            <label for="parameter-unit">Unit</label>
            <input id="parameter-unit" v-model="draft.unit" data-test="parameter-unit" />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!canCreate" data-test="parameter-create">
              Add
            </button>
          </div>
        </div>
      </form>
    </div>
  </details>
</template>

<style scoped>
.parameter-group h3 {
  margin-bottom: 0.3rem;
}
.parameter-group h3 em {
  font-weight: 400;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}
.option-list {
  list-style: none;
  margin: 0 0 0.4rem;
  padding: 0;
}
.option-list li {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
}
.option-list button {
  margin: 0;
  padding: 0 0.4rem;
  line-height: 1.4;
}
.option-add {
  display: flex;
  gap: 0.35rem;
}
.option-add input {
  margin: 0;
}
.option-add button {
  margin: 0;
}
</style>
