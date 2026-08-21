<script setup>
// What the linked oscilloscope is watching in this patch.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import ScopePanel from '../components/ScopePanel.vue';
import { usePatchFacts } from '../components/patchdetail/usePatchFacts.js';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
const { modules } = usePatchFacts(patch);
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <template v-if="patch">
    <ScopePanel :patch-id="id" :modules="modules" @captured="load" />
    <p class="muted" data-test="captures-note">
      A capture files itself under a note on this patch — see
      <RouterLink :to="`/patches/${id}/notes`">Notes on this patch</RouterLink>.
    </p>
  </template>
</template>
