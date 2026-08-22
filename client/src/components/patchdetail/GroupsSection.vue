<script setup>
import { computed, reactive, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { usePatchFacts } from './usePatchFacts.js';
import { useLazyPanel } from '../../lazyPanel.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// Built the first time it is opened (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const { modules, groups, moduleLabel } = usePatchFacts(toRef(props, 'patch'));

// ---- instances: names, labels and groups ----
const labelDraft = reactive({});
const nameDraft = reactive({});
const instanceError = ref('');

function labelKey(pm) {
  if (!(pm.id in labelDraft)) labelDraft[pm.id] = pm.label || '';
  return pm.id;
}

// The manufacturer and module name the patch snapshotted, editable in place
// so a typo or a piece of gear named in a hurry can be corrected. Both have
// to say something — an instance with no name cannot be picked out of the
// cable and settings pickers.
function nameKey(pm) {
  if (!(pm.id in nameDraft)) {
    nameDraft[pm.id] = {
      manufacturer: pm.manufacturer || '',
      module_name: pm.module_name || '',
    };
  }
  return pm.id;
}

function nameValid(pm) {
  const draft = nameDraft[pm.id];
  return Boolean(draft?.manufacturer.trim() && draft?.module_name.trim());
}

async function saveName(pm) {
  if (!nameValid(pm)) {
    instanceError.value = 'A manufacturer and a module name are both required.';
    return;
  }
  await saveInstance(pm, {
    manufacturer: nameDraft[pm.id].manufacturer.trim(),
    module_name: nameDraft[pm.id].module_name.trim(),
  });
}

async function saveInstance(pm, updates) {
  instanceError.value = '';
  try {
    await api.put(`/api/patches/${props.patchId}/modules/${pm.id}`, updates);
    emit('reload');
  } catch (e) {
    instanceError.value = e.message;
  }
}

async function removeInstance(pm) {
  const ok = await dialog.confirm({
    title: 'Remove module from patch',
    message:
      `Take ${moduleLabel(pm)} out of this patch? Its cables, settings and links ` +
      'in this patch go with it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  instanceError.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/modules/${pm.id}`);
    emit('reload');
  } catch (e) {
    instanceError.value = e.message;
  }
}

// ---- groups (named buses / layers) ----
const groupName = ref('');
const groupError = ref('');

async function addGroup() {
  groupError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/groups`, { name: groupName.value.trim() });
    groupName.value = '';
    emit('reload');
  } catch (e) {
    groupError.value = e.message;
  }
}

async function removeGroup(group) {
  const ok = await dialog.confirm({
    title: 'Remove bus',
    message: `Remove the '${group.name}' bus? The modules filed under it stay in the patch.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  groupError.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/groups/${group.id}`);
    emit('reload');
  } catch (e) {
    groupError.value = e.message;
  }
}

// Instances filed under each group, plus the ones not filed anywhere.
const groupedModules = computed(() => [
  ...groups.value.map((g) => ({
    group: g,
    members: modules.value.filter((m) => m.group_id === g.id),
  })),
  { group: null, members: modules.value.filter((m) => !m.group_id) },
]);
</script>

<template>
  <details class="panel" data-test="groups" @toggle="onToggle">
    <summary>
      <h2>Buses and layers</h2>
      <span class="summary-count">
        {{ groups.length }} {{ (groups.length) === 1 ? 'bus' : 'buss' }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
      <p class="muted">
        Name the groups a patch is really built from — a rhythm layer, a granular bus — and give
        each instance the role it plays, so "LXR #2" reads as the ghost-note voice it is. The
        manufacturer and module name are this patch's own, so correct either here when one came
        in wrong; both have to say something.
      </p>
      <div v-for="entry in groupedModules" :key="entry.group?.id ?? 'ungrouped'">
        <h3 v-if="entry.group" :data-test="`group-${entry.group.id}`">
          {{ entry.group.name }}
          <button
            class="danger"
            style="margin: 0 0 0 0.6rem; font-size: 0.8rem"
            :data-test="`delete-group-${entry.group.id}`"
            @click="removeGroup(entry.group)"
          >
            Remove
          </button>
        </h3>
        <h3 v-else-if="entry.members.length">Not in a bus</h3>
        <div v-if="entry.members.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Manufacturer and module</th>
                <th>Role in this patch</th>
                <th>Bus</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pm in entry.members" :key="pm.id" :data-test="`instance-${pm.id}`">
                <td data-label="Manufacturer and module" class="actions-cell">
                  <div class="actions nowrap">
                    <input
                      v-model="nameDraft[nameKey(pm)].manufacturer"
                      :data-test="`manufacturer-input-${pm.id}`"
                      placeholder="Manufacturer"
                      @keyup.enter="saveName(pm)"
                    />
                    <input
                      v-model="nameDraft[nameKey(pm)].module_name"
                      :data-test="`module-name-input-${pm.id}`"
                      placeholder="Module name"
                      @keyup.enter="saveName(pm)"
                    />
                    <span class="muted">#{{ pm.instance }}</span>
                    <button
                      :disabled="!nameValid(pm)"
                      :data-test="`name-save-${pm.id}`"
                      @click="saveName(pm)"
                    >
                      Save
                    </button>
                  </div>
                </td>
                <td data-label="Role in this patch" class="actions-cell">
                  <div class="actions nowrap">
                    <input
                      v-model="labelDraft[labelKey(pm)]"
                      :data-test="`label-input-${pm.id}`"
                      placeholder="e.g. snare voice"
                      @keyup.enter="saveInstance(pm, { label: labelDraft[pm.id] })"
                    />
                    <button
                      :data-test="`label-save-${pm.id}`"
                      @click="saveInstance(pm, { label: labelDraft[pm.id] })"
                    >
                      Save
                    </button>
                  </div>
                </td>
                <td data-label="Bus">
                  <select
                    :value="pm.group_id ?? ''"
                    :data-test="`group-select-${pm.id}`"
                    @change="saveInstance(pm, { group_id: $event.target.value || null })"
                  >
                    <option value="">—</option>
                    <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
                  </select>
                </td>
                <td>
                  <button
                    class="danger"
                    style="margin: 0"
                    :data-test="`remove-instance-${pm.id}`"
                    @click="removeInstance(pm)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-if="instanceError" class="error" data-test="instance-error">{{ instanceError }}</p>

      <form @submit.prevent="addGroup">
        <div class="row">
          <div>
            <label for="group-name">New bus / layer</label>
            <input id="group-name" v-model="groupName" data-test="group-name" placeholder="e.g. Rhythm" />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!groupName.trim()" data-test="group-create">
              Add
            </button>
          </div>
        </div>
        <p v-if="groupError" class="error" data-test="group-error">{{ groupError }}</p>
      </form>
    </div>
  </details>
</template>
