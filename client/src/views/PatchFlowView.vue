<script setup>
// Where signal goes once it leaves a jack: the traced flow, and the
// connections the modules make for themselves when nothing is plugged in.
import { computed, toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import FlowSection from '../components/patchdetail/FlowSection.vue';
import NormalledSection from '../components/patchdetail/NormalledSection.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));

// The outputs the traced flow arrives at, named with the instance they are on.
const reachedOutputs = computed(() => {
  const p = patch.value;
  if (!p) return [];
  const label = (id) => {
    const pm = (p.modules || []).find((m) => m.id === id);
    if (!pm) return '?';
    const base = `${pm.manufacturer || ''} ${pm.module_name || ''}`.trim();
    return pm.instance > 1 ? `${base} #${pm.instance}` : base;
  };
  return (p.outputs || [])
    .filter((o) => o.reached)
    .map((o) => `${label(o.patch_module_id)} "${o.component_name}"`);
});
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <template v-if="patch">
    <!-- Whether the traced flow gets to where the sound is meant to come
         out: the first thing to check when a patch is silent. -->
    <p v-if="patch.outputs?.length" data-test="outputs-reached">
      <template v-if="reachedOutputs.length">
        Audio reaches {{ reachedOutputs.join(', ') }}.
      </template>
      <template v-else>
        <strong>Nothing reaches an output</strong> — the patch ends before
        {{ (patch.outputs || []).map((o) => o.component_name).join(', ') }}.
      </template>
      <RouterLink :to="`/patches/${id}/gear`" class="muted">Outputs are set on the gear page.</RouterLink>
    </p>
    <FlowSection :patch="patch" />
    <NormalledSection :patch="patch" />
  </template>
</template>
