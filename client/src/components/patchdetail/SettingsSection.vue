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
    (s) => s.patch_module_id === pmId && s.component_id === componentId && !s.parameter_id
  );
}

// ---- menu parameters ----
// The settings a module keeps behind an encoder rather than under a control:
// an output jack's clock division, a global tempo. One jack carries as many
// of these as its menu has entries, which is why they are keyed by the
// PARAMETER and not by the component the way a knob's position is.
const menuParameters = computed(() => settingsModule.value?.parameters || []);

// Grouped by what they configure, because that is how a menu is read: "what
// is OUT 1 set to" rather than "what parameters does this module have".
const menuGroups = computed(() => {
  const componentsById = new Map((settingsModule.value?.components || []).map((c) => [c.id, c]));
  const byComponent = new Map();
  for (const p of menuParameters.value) {
    const key = p.component_id ?? 0;
    if (!byComponent.has(key)) byComponent.set(key, []);
    byComponent.get(key).push(p);
  }
  return [...byComponent.entries()]
    .map(([key, parameters]) => ({
      key,
      title: key === 0 ? 'The module itself' : (componentsById.get(key)?.name ?? 'Removed component'),
      parameters,
    }))
    .sort((a, b) => (a.key === 0 ? -1 : 0) - (b.key === 0 ? -1 : 0) || a.title.localeCompare(b.title));
});

function currentParameterSetting(pmId, parameterId) {
  return props.patch?.settings.find(
    (s) => s.patch_module_id === pmId && s.parameter_id === parameterId
  );
}

// The same shape the controls use: a listed set becomes a dropdown, a range
// becomes a number box, anything else free text.
function parameterControl(parameter) {
  if ((parameter.options || []).length > 0) return { kind: 'enum', options: parameter.options };
  if (parameter.value_type === 'number' || parameter.value_min != null || parameter.value_max != null) {
    return { kind: 'range', min: parameter.value_min, max: parameter.value_max };
  }
  return { kind: 'text' };
}

function parameterDraftKey(pmId, parameterId) {
  return `p${pmId}:${parameterId}`;
}

function parameterDraft(pmId, parameter) {
  const key = parameterDraftKey(pmId, parameter.id);
  if (!(key in draft)) {
    draft[key] =
      currentParameterSetting(pmId, parameter.id)?.value ?? parameter.default_value ?? '';
  }
  return key;
}

async function saveParameterSetting(parameter) {
  settingsError.value = '';
  const pmId = Number(settingsModuleId.value);
  try {
    await api.put(`/api/patches/${props.patchId}/settings`, {
      patch_module_id: pmId,
      parameter_id: parameter.id,
      value: draft[parameterDraftKey(pmId, parameter.id)],
    });
    emit('reload');
  } catch (e) {
    settingsError.value = e.message;
  }
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
    delete draft[parameterDraftKey(setting.patch_module_id, setting.parameter_id)];
    emit('reload');
  } catch (e) {
    settingsError.value = e.message;
  }
}

function settingLabel(setting) {
  const where = [setting.component_name, setting.parameter_name].filter(Boolean).join(' · ');
  return `${moduleLabel(modulesById.value.get(setting.patch_module_id))} — ${where || 'a setting'}`;
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

      <template v-if="settingsModule && menuParameters.length">
        <h3>Menu settings</h3>
        <p class="muted">
          What this module is set to in its own menu — the settings that have no control on the
          panel. Each belongs to the jack it configures, so one output can carry a dozen of them.
        </p>
        <div v-for="group in menuGroups" :key="group.key" class="table-wrap" :data-test="`menu-group-${group.key}`">
          <table :data-test="`menu-parameters-${group.key}`">
            <thead>
              <tr>
                <th>{{ group.title }}</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in group.parameters" :key="p.id" :data-test="`parameter-row-${p.id}`">
                <td>
                  {{ p.name }}
                  <span v-if="currentParameterSetting(Number(settingsModuleId), p.id)" class="badge found">
                    set
                  </span>
                  <div v-if="p.description" class="muted">{{ p.description }}</div>
                </td>
                <td>
                  <template v-if="parameterControl(p).kind === 'enum'">
                    <select
                      v-model="draft[parameterDraft(Number(settingsModuleId), p)]"
                      :data-test="`parameter-input-${p.id}`"
                    >
                      <option value="" disabled>Select…</option>
                      <option v-for="o in parameterControl(p).options" :key="o.id" :value="o.value">
                        {{ o.value }}{{ o.description ? ` — ${o.description}` : '' }}
                      </option>
                    </select>
                  </template>
                  <template v-else-if="parameterControl(p).kind === 'range'">
                    <input
                      v-model="draft[parameterDraft(Number(settingsModuleId), p)]"
                      type="number"
                      step="any"
                      :min="parameterControl(p).min"
                      :max="parameterControl(p).max"
                      :placeholder="`${parameterControl(p).min ?? '?'} … ${parameterControl(p).max ?? '?'}${p.unit ? ' ' + p.unit : ''}`"
                      :data-test="`parameter-input-${p.id}`"
                    />
                  </template>
                  <template v-else>
                    <input
                      v-model="draft[parameterDraft(Number(settingsModuleId), p)]"
                      :data-test="`parameter-input-${p.id}`"
                    />
                  </template>
                </td>
                <td>
                  <button
                    style="margin: 0"
                    :disabled="!String(draft[parameterDraftKey(Number(settingsModuleId), p.id)] ?? '').trim()"
                    :data-test="`parameter-save-${p.id}`"
                    @click="saveParameterSetting(p)"
                  >
                    Set
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <p v-if="settingsError" class="error" data-test="settings-error">{{ settingsError }}</p>
    </div>
  </details>
</template>
