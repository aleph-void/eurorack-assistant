<script setup>
// One KIND of thing on this module's panel — the input jacks, the knobs, the
// toggles — with the front plate beside them.
//
// Every component type gets its own page for the same reason the jacks did: a
// panel is a hundred things and the list of all of them is a page you scroll
// rather than read, while "the knobs" is a page you can take in. Where each
// one sits on the picture is the fact the patch diagram is built on, so the
// list and the plate are one screen: pick a row, its marker is the only one
// left on the panel, drag it onto the hardware it names.
//
// One view, two route shapes: /jacks/<input|output|bidirectional> for the
// things a cable goes in, /parts/<type> for everything else.

import { computed, toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import PanelJacksSection from '../components/moduledetail/PanelJacksSection.vue';
import { useArranging } from '../components/moduledetail/useArranging.js';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';
import { COMPONENT_TYPES, TYPE_LABELS } from '../componentTypes.js';

const props = defineProps({
  id: { type: String, required: true },
  // A component type: 'input_jack', 'knob', 'toggle', …
  type: { type: String, required: true },
});

// What each page is FOR, in the terms the hardware is in. A type with nothing
// to add here still gets its page — the heading and the list say enough.
const BLURBS = {
  input_jack: 'Where signal arrives. Every one of these can be the destination end of a patch cable.',
  output_jack: 'Where signal leaves. Every one of these can be the source end of a patch cable.',
  bidirectional_jack:
    'Mult jacks, switch jacks and anything else that runs either way. Which way one runs is ' +
    'decided by the patch: the end a cable is plugged into is the input.',
  knob: 'The continuous controls. What each is set to is recorded per patch, not here.',
  slider: 'The long-throw controls, dialed in per patch like the knobs.',
  button: 'Momentary controls — the things you press.',
  toggle: 'Two-position controls, on or off.',
  switch:
    'Multi-position controls. A switch that decides which signal is normalled to an input, or ' +
    'what an output carries, resolves the signal flow once its position is recorded in a patch.',
  display: 'Screens, meters and LEDs — what the module tells you, rather than what you tell it.',
  other: 'Everything on the panel that is none of the above.',
};

const id = toRef(props, 'id');
const { module, error, rackModules, load } = useModuleRecord(id);
const arranging = useArranging(module, id, load);

const type = computed(() => (COMPONENT_TYPES.includes(props.type) ? props.type : 'other'));
const title = computed(() => TYPE_LABELS[type.value] ?? 'Components');
const blurb = computed(() => BLURBS[type.value] ?? '');
const count = computed(
  () => (module.value?.components || []).filter((c) => c.type === type.value).length
);
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
    <details open class="panel" data-test="jacks">
      <summary>
        <h2>{{ title }}</h2>
        <span class="summary-count">{{ count }}</span>
      </summary>
      <div class="panel-body">
        <p v-if="blurb" class="muted" style="margin-top: 0" data-test="jacks-blurb">{{ blurb }}</p>
        <PanelJacksSection
          :module="module"
          :arranging="arranging"
          :kinds="[type]"
          data-test="jacks-section"
        />
        <p class="muted">
          Renaming one of these, changing what kind it is, or adding one the analysis missed is on
          the <RouterLink :to="`/modules/${id}/components`">Components</RouterLink> page.
        </p>
      </div>
    </details>
  </template>
</template>
