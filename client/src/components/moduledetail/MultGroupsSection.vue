<script setup>
// Which of this module's bidirectional jacks are copies of each other.
//
// A mult section IS its group label: bidirectional jacks on the same module
// sharing one (trimmed, case-insensitively) are the interchangeable jacks of
// one mult, and a patch works out which of them is the input from the end a
// cable is plugged into (services/patchFlow.js). So a 2x2 mult is TWO labels,
// not one — and until they are set, its four jacks are a single section:
// a cable into any of them is copied to all three others, and a cable
// between the two halves is refused as doing nothing (cableProblem()). That
// is the wrong hardware, which is why the label is edited on the page about
// these jacks rather than only in the components table.
//
// Every label is a draft until Save: setting a 2x2 mult right is four writes,
// and doing them a row at a time would re-read the module after each one.
//
// Some hardware does not have one answer to give. A Doepfer A-182-1 puts each
// of its eight jacks on one of two internal buses with a three-position
// toggle beside it, so which jacks are copies of each other is a fact about
// the PATCH — the toggle positions it records — and no label on the jack
// could hold it. Those jacks take a row per position instead
// (component_mult_groups, migration 038), edited here beside the labels:
// the control, the position, and the bus that position puts the jack on.

import { computed, reactive, ref, toRef, watch } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName, controls, controlValues } = useModuleFacts(toRef(props, 'module'));

// ---- switched jacks ----
// The positions recorded for each jack: while this control sits here, the
// jack is on that bus (or, with no label, on none of them).
const switchedRows = computed(() => props.module?.mult_groups || []);
const rowsOf = (jack) => switchedRows.value.filter((r) => r.component_id === jack.id);
const positionText = (row) =>
  `${componentName(row.condition_component_id)} = ${row.condition_value}`;

// A control can only decide a jack's bus if the module says what positions it
// has: an enum'd toggle or switch. One with no recorded positions is offered
// anyway, since a value can be typed, but the picker is what makes this
// bearable on a panel of eight toggles.
const conditionControls = computed(() => controls.value);

const addingFor = ref(null);
const addControl = ref('');
const addValue = ref('');
const addLabel = ref('');
const addError = ref('');
const addValues = computed(() => controlValues(addControl.value));

function startAdding(jack) {
  addingFor.value = jack.id;
  addControl.value = String(rowsOf(jack)[0]?.condition_component_id || '');
  addValue.value = '';
  addLabel.value = '';
  addError.value = '';
}

async function addPosition(jack) {
  addError.value = '';
  try {
    await api.post(`/api/modules/${props.moduleId}/mult-groups`, {
      component_id: jack.id,
      condition_component_id: Number(addControl.value),
      condition_value: addValue.value.trim(),
      group_label: addLabel.value.trim(),
    });
    addingFor.value = null;
    emit('reload');
  } catch (e) {
    addError.value = e.message;
  }
}

async function removePosition(jack, row) {
  const ok = await dialog.confirm({
    title: 'Remove switched position',
    message: `Stop deciding ${jack.name}'s section by ${positionText(row)}?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  addError.value = '';
  try {
    await api.delete(`/api/modules/${props.moduleId}/mult-groups/${row.id}`);
    emit('reload');
  } catch (e) {
    addError.value = e.message;
  }
}

// Named, not numbered, so listed by name — the order an analysis happened to
// find them in is no order at all.
const jacks = computed(() =>
  [...(props.module?.components || []).filter((c) => c.type === 'bidirectional_jack')].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  )
);

// A routing switch's jacks are bidirectional too, and they are NOT a mult:
// a switch selects one step at a time, and both the tracer and the cable
// rules leave its jacks out of every mult group. Say so on the row rather
// than letting a label be typed into it that nothing will ever read.
const switchSections = computed(() => {
  const byComponent = new Map();
  for (const s of props.module?.switches || []) {
    const name = s.name || `switch ${s.id}`;
    for (const id of [s.common_component_id, ...(s.step_component_ids || [])]) {
      if (id != null && !byComponent.has(id)) byComponent.set(id, name);
    }
  }
  return byComponent;
});
const switchSectionOf = (jack) => switchSections.value.get(jack.id) || null;

// The sections themselves, said in the terms the switch is in: the common
// jack and the steps it reaches one at a time. Read-only here — a section is
// built on the Switches page — but shown here because this is the page a
// switch module's jacks send you to, and 'not a mult' is only half an answer.
const switchList = computed(() =>
  (props.module?.switches || []).map((s) => ({
    id: s.id,
    name: s.name || `Switch ${s.id}`,
    common: componentName(s.common_component_id),
    steps: (s.step_component_ids || []).map(componentName),
  }))
);

// The labels as they are being edited, keyed by component id. Re-seeded from
// the record every time it is (re)loaded, so a save that lands is reflected
// and a reload elsewhere on the page does not leave stale drafts behind.
const drafts = reactive({});
watch(
  jacks,
  (rows) => {
    for (const key of Object.keys(drafts)) delete drafts[key];
    for (const jack of rows) drafts[jack.id] = jack.group_label || '';
  },
  { immediate: true }
);
const draftOf = (jack) => (drafts[jack.id] ?? '').trim();

const changed = computed(() => jacks.value.filter((j) => draftOf(j) !== (j.group_label || '')));

// What the drafts would make: the sections as the tracer would group them,
// which is the thing being edited even though the form is a list of jacks.
const sections = computed(() => {
  const groups = new Map();
  const join = (label, jack, when) => {
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, label, jacks: [] });
    groups.get(key).jacks.push({ name: jack.name, when });
  };
  for (const jack of jacks.value) {
    if (switchSectionOf(jack)) continue;
    const rows = rowsOf(jack);
    if (rows.length === 0) {
      join(draftOf(jack), jack, null);
      continue;
    }
    // A switched jack stands in every bus it can be switched to; which one it
    // is on is a fact of the patch, not of the module.
    for (const row of rows) {
      if (!String(row.group_label ?? '').trim()) continue;
      join(String(row.group_label).trim(), jack, positionText(row));
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
});

// The labels already in use, offered to every field: a jack joins a section
// by being given the same label, and retyping it is how that goes wrong.
const knownLabels = computed(() =>
  [...new Set(sections.value.map((s) => s.label).filter(Boolean))].sort((a, b) => a.localeCompare(b))
);

const saving = ref(false);
const error = ref('');
const notice = ref('');

async function saveGroups() {
  const rows = changed.value;
  if (!rows.length) return;
  error.value = '';
  notice.value = '';
  saving.value = true;
  let saved = 0;
  try {
    for (const jack of rows) {
      await api.put(`/api/modules/${props.moduleId}/components/${jack.id}`, {
        group_label: draftOf(jack),
      });
      saved += 1;
    }
    notice.value =
      rows.length === 1
        ? `${rows[0].name} saved.`
        : `${rows.length} jacks saved.`;
    emit('reload');
  } catch (e) {
    // What landed is already in the record; what did not is still typed into
    // the form. Re-reading here would throw the untyped-again labels away, so
    // the record is left alone and pressing Save again writes the rest (the
    // ones that did land are written a second time, which changes nothing).
    error.value = saved
      ? `${saved} of ${rows.length} saved — ${e.message}`
      : e.message;
  } finally {
    saving.value = false;
  }
}

function revert() {
  error.value = '';
  notice.value = '';
  for (const jack of jacks.value) drafts[jack.id] = jack.group_label || '';
}
</script>

<template>
  <details open class="panel" data-test="mult-groups">
    <summary>
      <h2>Mult groups</h2>
      <span class="summary-count">
        {{ sections.length }} {{ sections.length === 1 ? 'section' : 'sections' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted" style="margin-top: 0">
        The jacks of one mult section share a group label; a patch then treats them as copies of
        each other, with whichever one a cable is plugged into as the input. A 2×2 mult is two
        labels — say <code>1</code> and <code>2</code> — because jacks left ungrouped all count as
        ONE section. The label is only a name: case and surrounding spaces are ignored. Jacks that
        belong to a routing switch section or to a dual module's link cable are paired rather than
        copied and take no group.
      </p>
      <p class="muted" data-test="mult-groups-switched-blurb">
        On a switched multiple — a Doepfer A-182-1, where a toggle beside each jack picks which of
        two internal buses it sits on — no label on the jack could be right, because the answer
        changes with the toggle. Give such a jack one row per position instead: the control, the
        position, and the group that position puts it on (leave the group blank for a position that
        takes it off the buses). A patch then reads the toggle positions it has recorded; while one
        is not recorded the jack counts as a possibility on every bus it could be on, and nothing is
        copied or refused on the strength of it.
      </p>

      <p v-if="jacks.length === 0" class="muted" data-test="mult-groups-empty">
        No bidirectional jacks on this module yet. Turning a jack into one is on the
        <RouterLink :to="`/modules/${moduleId}/components`">Components</RouterLink> page.
      </p>

      <template v-else>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jack</th>
                <th>Saved group</th>
                <th>Group</th>
                <th>Switched by</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="jack in jacks" :key="jack.id" :data-test="`mult-group-row-${jack.id}`">
                <td data-label="Jack">
                  {{ jack.name }}
                  <em
                    v-if="switchSectionOf(jack)"
                    class="muted"
                    :data-test="`mult-group-switch-${jack.id}`"
                  >
                    · step of {{ switchSectionOf(jack) }} — selected, not copied
                  </em>
                </td>
                <td data-label="Saved group">{{ jack.group_label || '—' }}</td>
                <td data-label="Group">
                  <input
                    v-model="drafts[jack.id]"
                    :list="`mult-group-labels-${moduleId}`"
                    :disabled="rowsOf(jack).length > 0"
                    :placeholder="rowsOf(jack).length ? 'decided by the switch' : 'Ungrouped'"
                    :title="
                      rowsOf(jack).length
                        ? 'The positions beside this jack decide its section — the label is not read'
                        : ''
                    "
                    :data-test="`mult-group-input-${jack.id}`"
                  />
                </td>
                <td data-label="Switched by" :data-test="`mult-switched-${jack.id}`">
                  <ul v-if="rowsOf(jack).length" class="mult-positions">
                    <li v-for="row in rowsOf(jack)" :key="row.id">
                      <span>
                        {{ positionText(row) }} →
                        <strong>{{ row.group_label || 'no bus' }}</strong>
                      </span>
                      <button
                        type="button"
                        class="danger"
                        :data-test="`mult-position-remove-${row.id}`"
                        @click="removePosition(jack, row)"
                      >
                        Remove
                      </button>
                    </li>
                  </ul>
                  <form
                    v-if="addingFor === jack.id"
                    class="mult-position-form"
                    :data-test="`mult-position-form-${jack.id}`"
                    @submit.prevent="addPosition(jack)"
                  >
                    <select v-model="addControl" :data-test="`mult-position-control-${jack.id}`">
                      <option value="" disabled>Which control…</option>
                      <option v-for="c in conditionControls" :key="c.id" :value="String(c.id)">
                        {{ c.name }}
                      </option>
                    </select>
                    <input
                      v-model="addValue"
                      :list="`mult-position-values-${jack.id}`"
                      placeholder="Position (e.g. up)"
                      :data-test="`mult-position-value-${jack.id}`"
                    />
                    <datalist :id="`mult-position-values-${jack.id}`">
                      <option v-for="v in addValues" :key="v.id" :value="v.value"></option>
                    </datalist>
                    <input
                      v-model="addLabel"
                      :list="`mult-group-labels-${moduleId}`"
                      placeholder="Group (blank = no bus)"
                      :data-test="`mult-position-label-${jack.id}`"
                    />
                    <button
                      :disabled="!addControl || !addValue.trim()"
                      :data-test="`mult-position-save-${jack.id}`"
                    >
                      Add
                    </button>
                    <button type="button" class="secondary" @click="addingFor = null">Cancel</button>
                  </form>
                  <button
                    v-else
                    type="button"
                    class="secondary"
                    :data-test="`mult-position-add-${jack.id}`"
                    @click="startAdding(jack)"
                  >
                    {{ rowsOf(jack).length ? 'Add position' : 'Switched…' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="addError" class="error" data-test="mult-position-error">{{ addError }}</p>
        <datalist :id="`mult-group-labels-${moduleId}`">
          <option v-for="label in knownLabels" :key="label" :value="label"></option>
        </datalist>

        <div class="row" style="align-items: center; gap: 0.6rem">
          <button :disabled="saving || changed.length === 0" data-test="mult-groups-save" @click="saveGroups">
            {{ saving ? 'Saving…' : 'Save groups' }}
          </button>
          <button
            class="secondary"
            :disabled="saving || changed.length === 0"
            data-test="mult-groups-revert"
            @click="revert"
          >
            Revert
          </button>
          <span v-if="changed.length" class="muted" data-test="mult-groups-changed">
            {{ changed.length }} unsaved
          </span>
        </div>

        <p v-if="error" class="error" data-test="mult-groups-error">{{ error }}</p>
        <p v-if="notice" class="muted" data-test="mult-groups-notice">{{ notice }}</p>

        <h3>Mult sections</h3>
        <ul v-if="sections.length" class="mult-sections" data-test="mult-sections">
          <li v-for="section in sections" :key="section.key" :data-test="`mult-section-${section.key || 'ungrouped'}`">
            <strong>{{ section.label || 'Ungrouped' }}</strong>
            <span class="muted">
              —
              <template v-for="(j, i) in section.jacks" :key="j.name + (j.when || '')">
                {{ i ? ', ' : '' }}{{ j.name
                }}<template v-if="j.when"> (with {{ j.when }})</template>
              </template>
            </span>
            <em v-if="section.jacks.length < 2" class="muted">
              · one jack on its own copies nothing
            </em>
          </li>
        </ul>
        <p v-else class="muted" data-test="mult-sections-empty">
          None — every bidirectional jack on this module belongs to a switch section.
        </p>

        <h3>Switch sections</h3>
        <ul v-if="switchList.length" class="mult-sections" data-test="switch-sections">
          <li v-for="section in switchList" :key="section.id" :data-test="`switch-section-${section.id}`">
            <strong>{{ section.name }}</strong>
            <span class="muted">
              — {{ section.common }} ↔ {{ section.steps.join(', ') }}, one step at a time
            </span>
          </li>
        </ul>
        <p v-else class="muted" data-test="switch-sections-empty">
          None recorded. If these jacks are a router rather than a mult — one common jack reaching
          several others one at a time — they are a switch section, not a group: a switch SELECTS
          where a mult COPIES, and a group label on them would be read by nothing.
        </p>
        <p class="muted">
          Building or changing one is on the
          <RouterLink :to="`/modules/${moduleId}/switches`">Switches</RouterLink> page.
        </p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.mult-positions {
  list-style: none;
  margin: 0 0 0.4rem;
  padding: 0;
}
.mult-positions li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.15rem 0;
}
.mult-positions button {
  margin: 0;
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}
.mult-position-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.mult-position-form select,
.mult-position-form input {
  width: auto;
  margin: 0;
}
.mult-position-form button {
  margin: 0;
}
.mult-sections {
  margin: 0;
  padding-left: 1.1rem;
}
.mult-sections li {
  margin: 0.2rem 0;
}
</style>
