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

import { computed, reactive, ref, toRef, watch } from 'vue';
import { api } from '../../api.js';
import { useModuleFacts } from './useModuleFacts.js';

const props = defineProps({
  module: { type: Object, required: true },
  moduleId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { componentName } = useModuleFacts(toRef(props, 'module'));

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
  for (const jack of jacks.value) {
    if (switchSectionOf(jack)) continue;
    const label = draftOf(jack);
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, label, jacks: [] });
    groups.get(key).jacks.push(jack);
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
              </tr>
            </thead>
            <tbody>
              <tr v-for="jack in jacks" :key="jack.id" :data-test="`mult-group-row-${jack.id}`">
                <td>
                  {{ jack.name }}
                  <em
                    v-if="switchSectionOf(jack)"
                    class="muted"
                    :data-test="`mult-group-switch-${jack.id}`"
                  >
                    · step of {{ switchSectionOf(jack) }} — selected, not copied
                  </em>
                </td>
                <td>{{ jack.group_label || '—' }}</td>
                <td>
                  <input
                    v-model="drafts[jack.id]"
                    :list="`mult-group-labels-${moduleId}`"
                    placeholder="Ungrouped"
                    :data-test="`mult-group-input-${jack.id}`"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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
            <span class="muted"> — {{ section.jacks.map((j) => j.name).join(', ') }}</span>
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
.mult-sections {
  margin: 0;
  padding-left: 1.1rem;
}
.mult-sections li {
  margin: 0.2rem 0;
}
</style>
