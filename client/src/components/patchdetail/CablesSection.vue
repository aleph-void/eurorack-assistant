<script setup>
import { computed, nextTick, ref, toRef, watch } from 'vue';
import { api } from '../../api.js';
import { parseQuickCable } from '../../patchQuickCable.js';
import AutocompleteSelect from '../AutocompleteSelect.vue';
import {
  FROM_TYPES,
  TO_TYPES,
  isPatchPoint,
  jackLabel,
  usePatchFacts,
} from './usePatchFacts.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
  suggestions: { type: Array, default: () => [] },
});
const emit = defineEmits(['reload']);

const { modules, modulesById, moduleLabel, moduleOptions, cables, cableInto, cablesOutOf, jackCandidates, switchRoleOf } = usePatchFacts(toRef(props, 'patch'));

// ---- cable form ----
const fromModuleId = ref(''); // patch_module id
const fromComponentId = ref('');
const toModuleId = ref('');
const toComponentId = ref('');
const cableNote = ref('');
const cableOptional = ref(false);
const cableStacked = ref(false);
const cableAltGroup = ref('');
const cablePair = ref(false);
const cableError = ref('');
// Signal usually travels onward: with this on, the module a cable lands in
// becomes the source of the next one.
const chainFromDestination = ref(false);

// The four pickers, so choosing in one moves on to the next.
const fromModuleBox = ref(null);
const fromJackBox = ref(null);
const toModuleBox = ref(null);
const toJackBox = ref(null);
const focusBox = (box) => nextTick(() => box.value?.focus());

// A jack only belongs to the module it was picked on.
watch(fromModuleId, () => {
  fromComponentId.value = '';
});
watch(toModuleId, () => {
  toComponentId.value = '';
});

// A cable's ends are the jacks a person can reach: an expansion header
// carries signal between two panels but is a connector behind the panel, so
// it is never one of them (usePatchFacts.js).
const canSend = (c) => FROM_TYPES.includes(c.type) && isPatchPoint(c);
const canReceive = (c) => TO_TYPES.includes(c.type) && isPatchPoint(c);
const fromModules = computed(() => modules.value.filter((m) => m.components.some(canSend)));
const toModules = computed(() => modules.value.filter((m) => m.components.some(canReceive)));
const fromJacks = computed(
  () => modulesById.value.get(Number(fromModuleId.value))?.components.filter(canSend) || []
);
const toJacks = computed(
  () => modulesById.value.get(Number(toModuleId.value))?.components.filter(canReceive) || []
);

const fromModuleOptions = computed(() => moduleOptions(fromModules.value));
const toModuleOptions = computed(() => moduleOptions(toModules.value));

// An output can fan out, so its list says how busy it already is; a mult jack
// a cable feeds is its group's input and the copies come out of the others.
const fromJackOptions = computed(() => {
  const pmId = Number(fromModuleId.value);
  return fromJacks.value.map((c) => {
    const feeding = cableInto(pmId, c.id);
    const out = cablesOutOf(pmId, c.id).length;
    let hint;
    // A fed switch jack is not a mult jack: the signal comes out at the other
    // SIDE of the section, not at the jacks beside it.
    const role = switchRoleOf(pmId, c.id);
    if (feeding && role) {
      hint =
        role === 'common'
          ? 'switch input — it comes out of the selected step'
          : 'switch input — it comes out of the common';
    } else if (feeding && c.type === 'bidirectional_jack') {
      hint = 'mult input — copies come out of the others';
    } else if (out) hint = out === 1 ? '1 cable already' : `${out} cables already`;
    return { value: c.id, label: jackLabel(c), hint };
  });
});

// An input takes exactly one cable, so one that is already fed is shown with
// what is in it rather than offered and refused.
const toJackOptions = computed(() => {
  const pmId = Number(toModuleId.value);
  return toJacks.value.map((c) => {
    const taken = cableInto(pmId, c.id);
    return {
      value: c.id,
      label: jackLabel(c),
      hint: taken ? `in use — ${taken.from_component_name} is patched here` : undefined,
      disabled: Boolean(taken),
    };
  });
});
const cableValid = computed(
  () => fromModuleId.value && fromComponentId.value && toModuleId.value && toComponentId.value
);

// Jacks that carry the two halves of one signal. When both ends of a cable
// are halves of a pair, the patch can plug the other half at the same time.
const pairs = computed(() => props.patch?.pairs || []);
function pairedWith(pmId, componentId) {
  const pair = pairs.value.find(
    (p) =>
      p.patch_module_id === Number(pmId) &&
      (p.a_component_id === Number(componentId) || p.b_component_id === Number(componentId))
  );
  if (!pair) return null;
  const otherId =
    pair.a_component_id === Number(componentId) ? pair.b_component_id : pair.a_component_id;
  return modulesById.value.get(Number(pmId))?.components.find((c) => c.id === otherId) ?? null;
}
const pairable = computed(() => {
  if (!cableValid.value) return null;
  const from = pairedWith(fromModuleId.value, fromComponentId.value);
  const to = pairedWith(toModuleId.value, toComponentId.value);
  return from && to ? { from, to } : null;
});

// ---- one line, one cable ----
// "maths eor > optomix ch1 in": both ends named in the words you would use
// out loud, resolved against every jack in the patch as you type.
const quickLine = ref('');
const quickError = ref('');

const quickParsed = computed(() =>
  parseQuickCable(quickLine.value, {
    from: jackCandidates(FROM_TYPES, false),
    to: jackCandidates(TO_TYPES, true),
  })
);
const quickReady = computed(
  () => Boolean(quickParsed.value.from && quickParsed.value.to && !quickParsed.value.error)
);
const endpointText = (end) => `${end.module_label} — ${end.jack_name}`;

async function addQuickCable() {
  quickError.value = '';
  if (!quickReady.value) {
    quickError.value = quickParsed.value.error || 'Name both ends: source > destination';
    return;
  }
  const { from, to } = quickParsed.value;
  try {
    await api.post(`/api/patches/${props.patchId}/cables`, {
      from_patch_module_id: from.patch_module_id,
      from_component_id: from.component_id,
      to_patch_module_id: to.patch_module_id,
      to_component_id: to.component_id,
    });
    quickLine.value = '';
    emit('reload');
  } catch (e) {
    quickError.value = e.message;
  }
}

async function addCable() {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/cables`, {
      from_patch_module_id: Number(fromModuleId.value),
      from_component_id: Number(fromComponentId.value),
      to_patch_module_id: Number(toModuleId.value),
      to_component_id: Number(toComponentId.value),
      note: cableNote.value.trim() || undefined,
      optional: cableOptional.value || undefined,
      stacked: cableStacked.value || undefined,
      alt_group: cableAltGroup.value.trim() || undefined,
      pair: cablePair.value && pairable.value ? true : undefined,
    });
    // Following the signal: the module this cable landed in sends the next
    // one. Otherwise the source stays put, ready for another cable out of it.
    const destination = toModuleId.value;
    fromComponentId.value = '';
    toComponentId.value = '';
    if (chainFromDestination.value) {
      toModuleId.value = '';
      fromModuleId.value = destination;
      focusBox(fromJackBox);
    } else {
      focusBox(fromModuleBox);
    }
    cableNote.value = '';
    cableOptional.value = false;
    cableStacked.value = false;
    cableAltGroup.value = '';
    cablePair.value = false;
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

// The panel diagram only emits physical output → input gestures. Keep the
// write here alongside every other cable creator so errors land in the same
// visible place and the diagram refreshes from the server's canonical state.
async function connectCable(ends) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/cables`, ends);
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

// Unplugging is not gated behind the modal the other removals use: patching
// is done by plugging and unplugging over and over, and a cable is one click
// away from being plugged again.
async function removeCable(cable) {
  cableError.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/cables/${cable.id}`);
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

// Load an existing cable back into the form to plug a variant of it — the
// same output into somewhere else, or the same input from somewhere else.
async function reuseCable(cable) {
  cableError.value = '';
  fromModuleId.value = cable.from_patch_module_id;
  toModuleId.value = cable.to_patch_module_id;
  // The module watchers clear the jacks, so the jacks are set after them.
  await nextTick();
  fromComponentId.value = cable.from_component_id;
  toComponentId.value = cable.to_component_id;
  focusBox(toModuleBox);
}

const jackOf = (pmId, componentId) =>
  modulesById.value.get(pmId)?.components.find((c) => c.id === componentId) ?? null;

// A cable can only be turned around when both jacks can play the other role:
// mult jacks, a bridged pair, a switch section. Everywhere else the ends are
// fixed by the panel.
function reversible(cable) {
  const from = jackOf(cable.from_patch_module_id, cable.from_component_id);
  const to = jackOf(cable.to_patch_module_id, cable.to_component_id);
  return Boolean(from && to && canReceive(from) && canSend(to));
}

async function reverseCable(cable) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/cables/${cable.id}/reverse`, {});
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

// ---- suggestions ----
// Signal arrives at a module and nothing carries it onward. Off-rack gear is
// where a patch is supposed to end, so it is not a loose end.
const looseEnds = computed(() => {
  const fed = new Set(cables.value.map((c) => c.to_patch_module_id));
  const sending = new Set(cables.value.map((c) => c.from_patch_module_id));
  return modules.value.filter(
    (pm) =>
      fed.has(pm.id) &&
      !sending.has(pm.id) &&
      !pm.external &&
      pm.components.some(canSend)
  );
});

async function plugSuggestion(suggestion) {
  cableError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/cables`, {
      from_patch_module_id: suggestion.from_patch_module_id,
      from_component_id: suggestion.from_component_id,
      to_patch_module_id: suggestion.to_patch_module_id,
      to_component_id: suggestion.to_component_id,
    });
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

// Start a cable out of a module that has signal but sends none.
function patchFrom(pm) {
  fromModuleId.value = pm.id;
  focusBox(fromJackBox);
}

// Provisional cables and stackcables are recorded, not just drawn: toggling
// either one re-saves the cable in place.
async function toggleCableFlag(cable, field) {
  cableError.value = '';
  try {
    await api.put(`/api/patches/${props.patchId}/cables/${cable.id}`, { [field]: !cable[field] });
    emit('reload');
  } catch (e) {
    cableError.value = e.message;
  }
}

defineExpose({ connectCable, removeCable });
</script>

<template>
  <details open class="panel" data-test="cables">
    <summary>
      <h2>Cables</h2>
      <span class="summary-count">
        {{ patch.cables.length }} {{ (patch.cables.length) === 1 ? 'cable' : 'cables' }}
      </span>
    </summary>
    <div class="panel-body">
      <div v-if="patch.cables.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>From (output)</th>
              <th>To (input)</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cable in patch.cables" :key="cable.id" :data-test="`cable-${cable.id}`">
              <td>
                {{ moduleLabel(modulesById.get(cable.from_patch_module_id)) }} —
                <strong>{{ cable.from_component_name }}</strong>
              </td>
              <td>
                {{ moduleLabel(modulesById.get(cable.to_patch_module_id)) }} —
                <strong>{{ cable.to_component_name }}</strong>
              </td>
              <td>
                <span v-if="cable.optional" class="badge pending">optional</span>
                <span v-if="cable.stacked" class="badge found">stacked</span>
                <span v-if="cable.alt_group" class="badge pending">{{ cable.alt_group }}</span>
                {{ cable.note || '' }}
              </td>
              <td class="actions-cell">
                <div class="actions nowrap">
                  <button
                    class="secondary"
                    title="Load this cable into the form to plug a variant of it"
                    :data-test="`cable-reuse-${cable.id}`"
                    @click="reuseCable(cable)"
                  >
                    Reuse
                  </button>
                  <button
                    v-if="reversible(cable)"
                    class="secondary"
                    title="Swap the ends of this cable"
                    :data-test="`cable-reverse-${cable.id}`"
                    @click="reverseCable(cable)"
                  >
                    Reverse
                  </button>
                  <button
                    :data-test="`cable-optional-${cable.id}`"
                    @click="toggleCableFlag(cable, 'optional')"
                  >
                    {{ cable.optional ? 'Required' : 'Optional' }}
                  </button>
                  <button
                    :data-test="`cable-stacked-${cable.id}`"
                    @click="toggleCableFlag(cable, 'stacked')"
                  >
                    {{ cable.stacked ? 'Not stacked' : 'Stacked' }}
                  </button>
                  <button
                    class="danger"
                    :data-test="`delete-cable-${cable.id}`"
                    @click="removeCable(cable)"
                  >
                    Unplug
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No cables yet.</p>

      <form data-test="quick-form" @submit.prevent="addQuickCable">
        <label for="quick-cable">Quick entry — name both ends on one line</label>
        <div class="row">
          <div style="flex: 3">
            <input
              id="quick-cable"
              v-model="quickLine"
              data-test="quick-cable"
              placeholder="e.g. maths eor > optomix ch1 in"
            />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!quickReady" data-test="quick-create">
              Plug in
            </button>
          </div>
        </div>
        <p v-if="quickReady" class="muted" data-test="quick-preview">
          {{ endpointText(quickParsed.from) }} → {{ endpointText(quickParsed.to) }}
        </p>
        <template v-else-if="quickParsed.error">
          <p class="muted" data-test="quick-problem">{{ quickParsed.error }}</p>
          <p v-if="quickParsed.matches.length" class="muted" data-test="quick-matches">
            {{ quickParsed.matches.map(endpointText).join(' · ') }}
          </p>
        </template>
        <p v-if="quickError" class="error" data-test="quick-error">{{ quickError }}</p>
      </form>

      <form data-test="cable-form" @submit.prevent="addCable">
        <h3 style="margin-bottom: 0">Add a cable</h3>
        <p class="muted" style="margin: 0.2rem 0 0">
          Type to find each end — the arrow keys move through the matches, Enter takes the
          highlighted one and moves on to the next field.
        </p>
        <div class="row">
          <div>
            <label for="cable-from-module">From module</label>
            <AutocompleteSelect
              ref="fromModuleBox"
              v-model="fromModuleId"
              input-id="cable-from-module"
              data-test="cable-from-module"
              placeholder="Type a manufacturer, module or role…"
              :options="fromModuleOptions"
              @select="focusBox(fromJackBox)"
            />
          </div>
          <div>
            <label for="cable-from-jack">Output jack</label>
            <AutocompleteSelect
              ref="fromJackBox"
              v-model="fromComponentId"
              input-id="cable-from-jack"
              data-test="cable-from-jack"
              placeholder="Type a jack name…"
              empty-text="No output or mult jack matches"
              :disabled="!fromModuleId"
              :options="fromJackOptions"
              @select="focusBox(toModuleBox)"
            />
          </div>
          <div>
            <label for="cable-to-module">To module</label>
            <AutocompleteSelect
              ref="toModuleBox"
              v-model="toModuleId"
              input-id="cable-to-module"
              data-test="cable-to-module"
              placeholder="Type a manufacturer, module or role…"
              :options="toModuleOptions"
              @select="focusBox(toJackBox)"
            />
          </div>
          <div>
            <label for="cable-to-jack">Input jack</label>
            <AutocompleteSelect
              ref="toJackBox"
              v-model="toComponentId"
              input-id="cable-to-jack"
              data-test="cable-to-jack"
              placeholder="Type a jack name…"
              empty-text="No free input or mult jack matches"
              :disabled="!toModuleId"
              :options="toJackOptions"
            />
          </div>
          <div class="shrink">
            <button type="submit" style="margin: 0" :disabled="!cableValid" data-test="cable-create">
              Plug in
            </button>
          </div>
        </div>
        <div class="row">
          <div class="shrink">
            <label for="cable-chain">Chain — the next cable starts where this one lands</label>
            <input id="cable-chain" v-model="chainFromDestination" type="checkbox" data-test="cable-chain" />
          </div>
        </div>
        <div class="row">
          <div style="flex: 2">
            <label for="cable-note">Note (optional)</label>
            <input
              id="cable-note"
              v-model="cableNote"
              data-test="cable-note"
              placeholder="e.g. adds the distortion layer"
            />
          </div>
          <div>
            <label for="cable-alt-group">Alternative to (optional)</label>
            <input
              id="cable-alt-group"
              v-model="cableAltGroup"
              data-test="cable-alt-group"
              placeholder="e.g. vca choice"
            />
          </div>
          <div class="shrink">
            <label for="cable-optional">Provisional</label>
            <input id="cable-optional" v-model="cableOptional" type="checkbox" data-test="cable-optional" />
          </div>
          <div class="shrink">
            <label for="cable-stacked">Stackcable / mult</label>
            <input id="cable-stacked" v-model="cableStacked" type="checkbox" data-test="cable-stacked" />
          </div>
          <div v-if="pairable" class="shrink">
            <label for="cable-pair">
              Patch the pair ({{ pairable.from.name }} → {{ pairable.to.name }} too)
            </label>
            <input id="cable-pair" v-model="cablePair" type="checkbox" data-test="cable-pair" />
          </div>
        </div>
        <p v-if="cableError" class="error" data-test="cable-error">{{ cableError }}</p>
      </form>
    </div>
  </details>

  <details v-if="suggestions.length || looseEnds.length" class="panel" data-test="suggestions">
    <summary>
      <h2>What to patch next</h2>
      <span class="summary-count">{{ suggestions.length + looseEnds.length }}</span>
    </summary>
    <div class="panel-body">
      <template v-if="suggestions.length">
        <p class="muted">
          Cables you have plugged in your other patches, waiting to be plugged here — a rack is
          patched in habits.
        </p>
        <div class="table-wrap">
          <table>
            <tbody>
              <tr
                v-for="s in suggestions"
                :key="`${s.from_patch_module_id}:${s.from_component_id}-${s.to_patch_module_id}:${s.to_component_id}`"
                :data-test="`suggestion-${s.from_component_id}-${s.to_component_id}`"
              >
                <td>
                  {{ moduleLabel(modulesById.get(s.from_patch_module_id)) }} —
                  <strong>{{ s.from_component_name }}</strong>
                  →
                  {{ moduleLabel(modulesById.get(s.to_patch_module_id)) }} —
                  <strong>{{ s.to_component_name }}</strong>
                </td>
                <td class="muted">
                  in {{ s.patches }} other {{ s.patches === 1 ? 'patch' : 'patches' }}
                </td>
                <td>
                  <button
                    style="margin: 0"
                    :data-test="`plug-suggestion-${s.from_component_id}-${s.to_component_id}`"
                    @click="plugSuggestion(s)"
                  >
                    Plug in
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-if="looseEnds.length">
        <h3>Loose ends</h3>
        <p class="muted">
          Signal reaches these modules and nothing carries it onward. That is a patch in progress —
          or a module doing its work through a normalled connection.
        </p>
        <div class="table-wrap">
          <table>
            <tbody>
              <tr v-for="pm in looseEnds" :key="pm.id" :data-test="`loose-end-${pm.id}`">
                <td>{{ moduleLabel(pm) }}</td>
                <td>
                  <button
                    class="secondary"
                    style="margin: 0"
                    :data-test="`patch-from-${pm.id}`"
                    @click="patchFrom(pm)"
                  >
                    Patch from here
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </details>
</template>
