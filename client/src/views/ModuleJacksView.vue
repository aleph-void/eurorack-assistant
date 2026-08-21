<script setup>
// One kind of jack on this module — the inputs, the outputs, or the mults and
// other bidirectional connectors — with the front plate beside them.
//
// A jack is the thing a cable goes in, so where it sits on the picture is the
// fact the whole patch diagram is built on. That makes the list of them and
// the plate one screen rather than two: pick a jack, its marker is the only
// one left on the panel, drag it onto the socket it names.
//
// Three routes, one view: the kind comes from the path.

import { computed, toRef } from 'vue';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import PanelJacksSection from '../components/moduledetail/PanelJacksSection.vue';
import { useArranging } from '../components/moduledetail/useArranging.js';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';

const props = defineProps({
  id: { type: String, required: true },
  // 'input' | 'output' | 'bidirectional'
  kind: { type: String, required: true },
});

const KINDS = {
  input: {
    type: 'input_jack',
    title: 'Input jacks',
    blurb: 'Where signal arrives. Every one of these can be the destination end of a patch cable.',
  },
  output: {
    type: 'output_jack',
    title: 'Output jacks',
    blurb: 'Where signal leaves. Every one of these can be the source end of a patch cable.',
  },
  bidirectional: {
    type: 'bidirectional_jack',
    title: 'Bidirectional jacks',
    blurb:
      'Mult jacks, switch jacks and anything else that runs either way. Which way one runs is ' +
      'decided by the patch: the end a cable is plugged into is the input.',
  },
};

const id = toRef(props, 'id');
const { module, error, rackModules, load } = useModuleRecord(id);
const arranging = useArranging(module, id, load);

const kind = computed(() => KINDS[props.kind] || KINDS.input);
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
        <h2>{{ kind.title }}</h2>
        <span class="summary-count">
          {{ (module.components || []).filter((c) => c.type === kind.type).length }}
        </span>
      </summary>
      <div class="panel-body">
        <p class="muted" style="margin-top: 0" data-test="jacks-blurb">{{ kind.blurb }}</p>
        <PanelJacksSection
          :module="module"
          :arranging="arranging"
          :kinds="[kind.type]"
          data-test="jacks-section"
        />
        <p class="muted">
          Renaming a jack, changing what kind it is, or adding one the analysis missed is on the
          <RouterLink :to="`/modules/${id}/components`">Components</RouterLink> page.
        </p>
      </div>
    </details>
  </template>
</template>
