<script setup>
import { computed, toRef } from 'vue';
import { portKindLabel, usePatchFacts } from './usePatchFacts.js';

const props = defineProps({
  patch: { type: Object, required: true },
});

const { modulesById, moduleLabel, conditionText } = usePatchFacts(toRef(props, 'patch'));

// ---- signal flow ----
// Server-built trees: one per signal source (generator outputs, internal
// normalled signals), flattened here into indented rows for display.
const EDGE_LABELS = {
  cable: 'cable',
  route: 'internal path',
  normal: 'normalled',
  mult: 'mult copy',
  switch: 'switch position',
  bridge: 'bridged link',
};

const flowRows = computed(() => {
  const rows = [];
  const walk = (node, depth) => {
    rows.push({ node, depth });
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const tree of props.patch?.flow || []) walk(tree, 0);
  return rows;
});

const flowTruncated = computed(() => (props.patch?.flow || []).some((t) => t.truncated_tree));

function flowNodeText(node) {
  return `${moduleLabel(modulesById.value.get(node.patch_module_id))} — ${node.name}`;
}
</script>

<template>
  <details v-if="patch.flow?.length" class="panel" data-test="flow">
    <summary>
      <h2>Signal flow</h2>
      <span class="summary-count">
        {{ flowRows.length }} {{ (flowRows.length) === 1 ? 'step' : 'steps' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Every signal source in the patch — generator outputs (which no internal path feeds) and
        internal normalled signals — traced through cables, mult copies, normalled connections,
        each module's internal signal paths, expander panels and bridged links to everywhere it
        goes. Splits show as branches; merges, alternatives (only one is live at a time) and
        feedback loops are flagged.
      </p>
      <p v-if="flowTruncated" class="muted" data-test="flow-truncated">
        One or more paths were cut short — this patch's graph is larger than the tracer follows
        in one tree.
      </p>
      <div
        v-for="(row, i) in flowRows"
        :key="i"
        :style="{ paddingLeft: `${row.depth * 1.4}rem`, padding: `0.15rem 0 0.15rem ${row.depth * 1.4}rem` }"
        :data-test="`flow-row-${i}`"
      >
        <span v-if="row.node.via" class="muted">{{ EDGE_LABELS[row.node.via] || row.node.via }} → </span>
        <strong v-if="row.depth === 0">{{ flowNodeText(row.node) }}</strong>
        <template v-else>{{ flowNodeText(row.node) }}</template>
        <span v-if="row.node.port_kind" class="badge">{{ portKindLabel(row.node.port_kind) }}</span>
        <span v-if="row.depth === 0" class="badge found">
          {{ row.node.kind === 'internal' ? 'internal source' : 'generator' }}
        </span>
        <span v-if="row.node.switched && !row.node.conditional" class="badge pending">
          one switch position
        </span>
        <span v-if="row.node.conditional" class="badge pending">
          {{ conditionText(row.node.condition) }}
        </span>
        <span v-if="row.node.optional" class="badge pending">optional cable</span>
        <span v-if="row.node.merge" class="badge pending">merge point</span>
        <span v-if="row.node.switched_merge" class="badge pending">
          switched — one source at a time
        </span>
        <span v-if="row.node.cycle" class="badge failed">feedback loop ↺</span>
        <span v-if="row.node.truncated" class="badge failed">…path cut short</span>
      </div>
    </div>
  </details>
</template>
