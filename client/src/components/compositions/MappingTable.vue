<script setup>
// Binding each part of a composition to what plays it in ONE patch.
//
// A part may need several things — a voice is an oscillator, a filter and
// the envelope that opens it — so each element carries a list of bindings,
// and a binding is one of four shapes: a module instance, one control or
// jack of an instance, a bus, or a cable. The pickers are built from the
// patch payload the page already reads, and name things the way the patch's
// own pages do (usePatchFacts), so the label a binding is stored under is
// the label it was chosen by.
//
// A binding whose target has since left the patch is drawn as such rather
// than dropped: the label still says what it was, and the fix is to bind
// the right thing and remove the stale one.
import { computed, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { usePatchFacts } from '../patchdetail/usePatchFacts.js';
import { TARGET_KINDS, kindColor, kindLabel } from '../../compositionVocabulary.js';

const props = defineProps({
  realization: { type: Object, required: true },
  patch: { type: Object, default: null },
  compositionId: { type: String, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const patchRef = toRef(props, 'patch');
const { modules, modulesById, groups, moduleLabel } = usePatchFacts(patchRef);

const base = computed(
  () => `/api/compositions/${props.compositionId}/patches/${props.patchId}/mappings`
);
const elements = computed(() => props.realization.elements || []);
const mappingsByElement = computed(() => {
  const map = new Map();
  for (const m of props.realization.mappings || []) {
    if (!map.has(m.element_id)) map.set(m.element_id, []);
    map.get(m.element_id).push(m);
  }
  return map;
});
const bindingsOf = (element) => mappingsByElement.value.get(element.id) ?? [];
const mappedCount = computed(
  () => elements.value.filter((e) => bindingsOf(e).some((m) => m.live)).length
);

// ---- the pickers ----
const cables = computed(() => patchRef.value?.cables || []);
const cableLabel = (cable) =>
  `${moduleLabel(modulesById.value.get(cable.from_patch_module_id))} ${cable.from_component_name} → ` +
  `${moduleLabel(modulesById.value.get(cable.to_patch_module_id))} ${cable.to_component_name}`;

const bindingFor = ref(null);
const targetKind = ref('module');
const pickedModule = ref('');
const pickedComponent = ref('');
const pickedGroup = ref('');
const pickedCable = ref('');
const note = ref('');
const error = ref('');
const busy = ref(false);

const componentsOfPicked = computed(() => {
  const pm = modulesById.value.get(Number(pickedModule.value));
  return pm?.components ?? [];
});

function startBinding(element) {
  bindingFor.value = element.id;
  error.value = '';
  note.value = '';
}

const body = computed(() => {
  if (targetKind.value === 'group') return { group_id: Number(pickedGroup.value) || null };
  if (targetKind.value === 'cable') return { cable_id: Number(pickedCable.value) || null };
  const out = { patch_module_id: Number(pickedModule.value) || null };
  if (targetKind.value === 'component') out.component_id = Number(pickedComponent.value) || null;
  return out;
});

const canBind = computed(() => {
  if (targetKind.value === 'group') return Boolean(pickedGroup.value);
  if (targetKind.value === 'cable') return Boolean(pickedCable.value);
  if (targetKind.value === 'component') return Boolean(pickedModule.value && pickedComponent.value);
  return Boolean(pickedModule.value);
});

async function bind(element) {
  error.value = '';
  busy.value = true;
  try {
    await api.post(base.value, { element_id: element.id, ...body.value, note: note.value });
    note.value = '';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function unbind(mapping) {
  error.value = '';
  try {
    await api.delete(`${base.value}/${mapping.id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="panel" data-test="mapping-table">
    <h2 class="actions">
      Parts and what plays them
      <span class="badge" :class="{ complete: elements.length && mappedCount === elements.length }" data-test="coverage">
        {{ mappedCount }} of {{ elements.length }} parts mapped
      </span>
    </h2>
    <p v-if="error" class="error" data-test="mapping-error">{{ error }}</p>
    <p v-if="!elements.length" class="muted" data-test="no-elements">
      This composition has no parts yet — add them on its storyboard first.
    </p>
    <div v-else class="table-wrap">
      <table data-test="bindings">
        <thead>
          <tr>
            <th>Part</th>
            <th>Played by</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="element in elements" :key="element.id" :data-test="`binding-row-${element.id}`">
            <td data-label="Part">
              <span class="element-name">
                <span class="type-swatch" :style="{ background: kindColor(element.kind) }"></span>
                {{ element.name }}
              </span>
              <span class="muted element-kind">{{ kindLabel(element.kind) }}</span>
            </td>
            <td data-label="Played by">
              <p v-if="!bindingsOf(element).length" class="muted unmapped" data-test="unmapped">
                Not mapped yet
              </p>
              <ul v-else class="binding-list">
                <li
                  v-for="m in bindingsOf(element)"
                  :key="m.id"
                  :class="{ stale: !m.live }"
                  :data-test="`mapping-${m.id}`"
                >
                  <span class="badge">{{ TARGET_KINDS.find((k) => k.key === m.kind)?.label }}</span>
                  <span class="target">{{ m.target_label }}</span>
                  <span v-if="!m.live" class="muted" data-test="stale">(no longer in the patch)</span>
                  <span v-if="m.note" class="muted note">— {{ m.note }}</span>
                  <button type="button" class="secondary small" data-test="unbind" @click="unbind(m)">
                    Remove
                  </button>
                </li>
              </ul>
              <form
                v-if="bindingFor === element.id"
                class="bind-form"
                :data-test="`bind-form-${element.id}`"
                @submit.prevent="bind(element)"
              >
                <select v-model="targetKind" data-test="target-kind" aria-label="Bind to">
                  <option v-for="k in TARGET_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                </select>
                <select
                  v-if="targetKind === 'module' || targetKind === 'component'"
                  v-model="pickedModule"
                  data-test="pick-module"
                  aria-label="Module instance"
                >
                  <option value="">Choose a module…</option>
                  <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm) }}</option>
                </select>
                <select
                  v-if="targetKind === 'component'"
                  v-model="pickedComponent"
                  data-test="pick-component"
                  aria-label="Control or jack"
                >
                  <option value="">Choose a control or jack…</option>
                  <option v-for="c in componentsOfPicked" :key="c.id" :value="c.id">
                    {{ c.name }} ({{ String(c.type).replace(/_/g, ' ') }})
                  </option>
                </select>
                <select v-if="targetKind === 'group'" v-model="pickedGroup" data-test="pick-group" aria-label="Bus">
                  <option value="">Choose a bus…</option>
                  <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
                </select>
                <select v-if="targetKind === 'cable'" v-model="pickedCable" data-test="pick-cable" aria-label="Cable">
                  <option value="">Choose a cable…</option>
                  <option v-for="c in cables" :key="c.id" :value="c.id">{{ cableLabel(c) }}</option>
                </select>
                <input v-model="note" placeholder="Note — 'ride it, never below 9'" data-test="bind-note" />
                <div class="actions">
                  <button type="submit" :disabled="busy || !canBind" data-test="bind-submit">Bind</button>
                  <button type="button" class="secondary" @click="bindingFor = null">Done</button>
                </div>
              </form>
            </td>
            <td>
              <button
                v-if="bindingFor !== element.id"
                type="button"
                :data-test="`bind-${element.id}`"
                @click="startBinding(element)"
              >
                Bind…
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.element-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}
.element-kind {
  display: block;
  font-size: 0.8rem;
}
.unmapped {
  margin: 0;
}
.binding-list {
  list-style: none;
  padding: 0;
  margin: 0 0 0.4rem;
}
.binding-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0;
}
.binding-list li.stale .target {
  text-decoration: line-through;
  color: var(--muted);
}
.small {
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
}
.bind-form {
  display: grid;
  gap: 0.35rem;
  max-width: 32rem;
  margin-top: 0.4rem;
}
</style>
