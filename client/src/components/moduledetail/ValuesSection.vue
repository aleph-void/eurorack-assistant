<script setup>
import { computed, ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// ---- component values (valid settings) ----
const valueComponent = ref(''); // component id
const valueType = ref('enum');
const valueValue = ref('');
const valueDescription = ref('');
const valueError = ref('');

const allValues = computed(() =>
  (props.module?.components || []).flatMap((c) =>
    (c.values || []).map((v) => ({ ...v, component: c }))
  )
);

const valueValid = computed(() => valueComponent.value && valueValue.value.trim() !== '');

async function createValue() {
  valueError.value = '';
  try {
    const payload = { type: valueType.value, value: valueValue.value.trim() };
    if (valueDescription.value.trim()) payload.description = valueDescription.value.trim();
    await api.post(
      `/api/modules/${props.moduleId}/components/${valueComponent.value}/values`,
      payload
    );
    valueValue.value = '';
    valueDescription.value = '';
    emit('reload');
  } catch (e) {
    valueError.value = e.message;
  }
}

// An existing row's label and description are editable in place: the analysis
// records a switch position's meaning from the manual and often gets the
// wording thin or wrong, and re-typing the row from scratch to fix a sentence
// is busywork. The type stays fixed — a min is not turned into an enum.
const editingValueId = ref(null);
const editValueValue = ref('');
const editValueDescription = ref('');

function startEditValue(v) {
  editingValueId.value = v.id;
  editValueValue.value = v.value;
  editValueDescription.value = v.description || '';
  valueError.value = '';
}

function cancelEditValue() {
  editingValueId.value = null;
}

async function saveValue(v) {
  valueError.value = '';
  try {
    await api.put(`/api/modules/${props.moduleId}/components/${v.component.id}/values/${v.id}`, {
      value: editValueValue.value.trim(),
      description: editValueDescription.value.trim(),
    });
    editingValueId.value = null;
    emit('reload');
  } catch (e) {
    valueError.value = e.message;
  }
}

async function removeValue(v) {
  const ok = await dialog.confirm({
    title: 'Remove position',
    message: `Remove the '${v.value}' position of ${v.component?.name || 'this control'}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  valueError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/components/${v.component.id}/values/${v.id}`);
    if (editingValueId.value === v.id) editingValueId.value = null;
    emit('reload');
  } catch (e) {
    valueError.value = e.message;
  }
}
</script>

<template>
  <details v-if="module.components?.length" class="panel" data-test="values">
    <summary>
      <h2>Component values</h2>
      <span class="summary-count">
        {{ allValues.length }} {{ (allValues.length) === 1 ? 'value' : 'values' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        The valid settings of each control, extracted from the manual — a min/max pair for a
        continuous range, or one entry per position of a switch. They drive the setting controls
        when this module is used in a <RouterLink to="/patches">patch</RouterLink>; correct them
        here if the analysis got them wrong.
      </p>
      <div v-if="allValues.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Type</th>
              <th>Value</th>
              <th>Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in allValues" :key="v.id" :data-test="`value-${v.id}`">
              <td>{{ v.component.name }}</td>
              <td>{{ v.type }}</td>
              <td>
                <input
                  v-if="editingValueId === v.id"
                  v-model="editValueValue"
                  :data-test="`edit-value-value-${v.id}`"
                />
                <template v-else>{{ v.value }}</template>
              </td>
              <td>
                <input
                  v-if="editingValueId === v.id"
                  v-model="editValueDescription"
                  placeholder="What this setting does"
                  :data-test="`edit-value-description-${v.id}`"
                />
                <template v-else>{{ v.description || '—' }}</template>
              </td>
              <td class="actions-cell">
                <div class="actions nowrap">
                  <template v-if="editingValueId === v.id">
                    <button :data-test="`save-value-${v.id}`" @click="saveValue(v)">Save</button>
                    <button @click="cancelEditValue">Cancel</button>
                  </template>
                  <template v-else>
                    <button :data-test="`edit-value-${v.id}`" @click="startEditValue(v)">
                      Edit
                    </button>
                    <button
                      class="danger"
                      :data-test="`delete-value-${v.id}`"
                      @click="removeValue(v)"
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
      <p v-else class="muted">No values recorded for this module's components.</p>

      <form @submit.prevent="createValue">
        <div class="row">
          <div>
            <label for="value-component">Component</label>
            <select id="value-component" v-model="valueComponent" data-test="value-component">
              <option value="" disabled>Select a component…</option>
              <option v-for="c in module.components" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.type }})
              </option>
            </select>
          </div>
          <div class="shrink">
            <label for="value-type">Type</label>
            <select id="value-type" v-model="valueType" data-test="value-type">
              <option value="enum">enum (one position)</option>
              <option value="min">min</option>
              <option value="max">max</option>
            </select>
          </div>
          <div>
            <label for="value-value">Value</label>
            <input id="value-value" v-model="valueValue" data-test="value-value" placeholder="e.g. LP or 0" />
          </div>
          <div style="flex: 2">
            <label for="value-description">Description (optional)</label>
            <input id="value-description" v-model="valueDescription" data-test="value-description" />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!valueValid" data-test="value-create">
              Add
            </button>
          </div>
        </div>
        <p v-if="valueError" class="error" data-test="value-error">{{ valueError }}</p>
      </form>
    </div>
  </details>
</template>
