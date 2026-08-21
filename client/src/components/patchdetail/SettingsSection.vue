<script setup>
import { computed, reactive, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import AutocompleteSelect from '../AutocompleteSelect.vue';
import { usePatchFacts } from './usePatchFacts.js';
import { useLazyPanel } from '../../lazyPanel.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// Built the first time it is opened (lazyPanel.js).
const { opened, onToggle } = useLazyPanel();

const { modules, modulesById, moduleLabel, moduleOptions } = usePatchFacts(toRef(props, 'patch'));

// ---- settings form ----
const settingsModuleId = ref(''); // patch_module id
const settingsError = ref('');
// Draft value per component id of the selected module instance.
const draft = reactive({});

// ---- settings ----

const settingsModules = computed(() => modules.value.filter((m) => m.live));
const settingsModuleOptions = computed(() => moduleOptions(settingsModules.value));
const settingsModule = computed(() => modulesById.value.get(Number(settingsModuleId.value)));
// Controls you can dial in: everything that isn't a jack.
const settableComponents = computed(
  () => settingsModule.value?.components.filter((c) => !c.type.endsWith('_jack')) || []
);

function currentSetting(pmId, componentId) {
  return props.patch?.settings.find(
    (s) => s.patch_module_id === pmId && s.component_id === componentId
  );
}

// The recorded valid values shape each control: enum positions become a
// dropdown, a min/max range becomes a number input, anything else free text.
function control(component) {
  const options = (component.values || []).filter((v) => v.type === 'enum');
  if (options.length > 0) return { kind: 'enum', options };
  const min = (component.values || []).find((v) => v.type === 'min')?.value;
  const max = (component.values || []).find((v) => v.type === 'max')?.value;
  if (min !== undefined || max !== undefined) {
    const numeric = [min, max].every((v) => v === undefined || v.trim() === '' || !Number.isNaN(Number(v)));
    return { kind: numeric ? 'range' : 'text', min, max };
  }
  return { kind: 'text' };
}

function draftKey(pmId, componentId) {
  return `${pmId}:${componentId}`;
}

function draftValue(pmId, component) {
  const key = draftKey(pmId, component.id);
  if (!(key in draft)) {
    draft[key] = currentSetting(pmId, component.id)?.value ?? '';
  }
  return key;
}

async function saveSetting(component) {
  settingsError.value = '';
  const pmId = Number(settingsModuleId.value);
  try {
    await api.put(`/api/patches/${props.patchId}/settings`, {
      patch_module_id: pmId,
      component_id: component.id,
      value: draft[draftKey(pmId, component.id)],
    });
    emit('reload');
  } catch (e) {
    settingsError.value = e.message;
  }
}

async function removeSetting(setting) {
  const ok = await dialog.confirm({
    title: 'Remove setting',
    message: `Remove the recorded '${setting.value}' for ${settingLabel(setting)}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  settingsError.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/settings/${setting.id}`);
    delete draft[draftKey(setting.patch_module_id, setting.component_id)];
    emit('reload');
  } catch (e) {
    settingsError.value = e.message;
  }
}

function settingLabel(setting) {
  return `${moduleLabel(modulesById.value.get(setting.patch_module_id))} — ${setting.component_name}`;
}
</script>

<template>
  <details class="panel" data-test="settings" @toggle="onToggle">
    <summary>
      <h2>Control settings</h2>
      <span class="summary-count">
        {{ patch.settings.length }}
        {{ patch.settings.length === 1 ? 'setting' : 'settings' }}
      </span>
    </summary>
    <div v-if="opened" class="panel-body">
      <p class="muted">
        How each control is dialed in. Settings are more than a record: a switch that decides
        which signal is normalled to an input, or turns an output into a channel mix, resolves
        the signal flow above once its position is recorded here.
      </p>
      <div v-if="patch.settings.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Control</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="setting in patch.settings" :key="setting.id" :data-test="`setting-${setting.id}`">
              <td>{{ settingLabel(setting) }}</td>
              <td>
                <strong>{{ setting.value }}</strong>
              </td>
              <td>
                <button
                  class="danger"
                  style="margin: 0"
                  :data-test="`delete-setting-${setting.id}`"
                  @click="removeSetting(setting)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No settings recorded yet.</p>

      <div class="row">
        <div>
          <label for="settings-module">Dial in a module — type to find it</label>
          <AutocompleteSelect
            v-model="settingsModuleId"
            input-id="settings-module"
            data-test="settings-module"
            placeholder="Type a manufacturer, module or role…"
            :options="settingsModuleOptions"
          />
        </div>
      </div>

      <div v-if="settingsModule && settableComponents.length" class="table-wrap">
        <table data-test="settings-controls">
          <thead>
            <tr>
              <th>Control</th>
              <th>Type</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in settableComponents" :key="c.id" :data-test="`control-${c.id}`">
              <td>
                {{ c.name }}
                <span v-if="currentSetting(Number(settingsModuleId), c.id)" class="badge found">set</span>
              </td>
              <td>{{ c.type }}</td>
              <td>
                <template v-if="control(c).kind === 'enum'">
                  <select v-model="draft[draftValue(Number(settingsModuleId), c)]" :data-test="`control-input-${c.id}`">
                    <option value="" disabled>Select…</option>
                    <option v-for="v in control(c).options" :key="v.id" :value="v.value">
                      {{ v.value }}{{ v.description ? ` — ${v.description}` : '' }}
                    </option>
                  </select>
                </template>
                <template v-else-if="control(c).kind === 'range'">
                  <input
                    v-model="draft[draftValue(Number(settingsModuleId), c)]"
                    type="number"
                    step="any"
                    :min="control(c).min"
                    :max="control(c).max"
                    :placeholder="`${control(c).min ?? '?'} … ${control(c).max ?? '?'}`"
                    :data-test="`control-input-${c.id}`"
                  />
                </template>
                <template v-else>
                  <input
                    v-model="draft[draftValue(Number(settingsModuleId), c)]"
                    :placeholder="'e.g. 12 o\'clock'"
                    :data-test="`control-input-${c.id}`"
                  />
                </template>
              </td>
              <td>
                <button
                  style="margin: 0"
                  :disabled="!String(draft[draftKey(Number(settingsModuleId), c.id)] ?? '').trim()"
                  :data-test="`control-save-${c.id}`"
                  @click="saveSetting(c)"
                >
                  Set
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="settingsModule" class="muted">
        This module has no knobs, switches or other controls recorded.
      </p>
      <p v-if="settingsError" class="error" data-test="settings-error">{{ settingsError }}</p>
    </div>
  </details>
</template>
