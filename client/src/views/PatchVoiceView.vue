<script setup>
// The same two lists, said out loud. Voice needs the ends kept whole rather
// than parsed from one line, the cables already plugged (so they can be
// pulled out by name), and the words this rack uses — a recogniser has never
// heard of Mimeophon and does better when it is told the names to expect.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import VoicePatchPanel from '../components/VoicePatchPanel.vue';
import {
  FROM_TYPES,
  TO_TYPES,
  usePatchFacts,
} from '../components/patchdetail/usePatchFacts.js';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
const { modules, modulesById, moduleLabel, cables, jackCandidates } = usePatchFacts(patch);

const voiceFrom = () => jackCandidates(FROM_TYPES, false);
const voiceTo = () => jackCandidates(TO_TYPES, true);
const cableCandidates = () =>
  cables.value.map((c) => ({
    cable_id: c.id,
    module_label: `${moduleLabel(modulesById.value.get(c.from_patch_module_id))} ${c.from_component_name}`,
    jack_name: `${moduleLabel(modulesById.value.get(c.to_patch_module_id))} ${c.to_component_name}`,
  }));
const vocabulary = () => {
  const words = new Set();
  for (const pm of modules.value) {
    words.add(pm.manufacturer);
    words.add(pm.module_name);
    if (pm.label) words.add(pm.label);
    for (const c of pm.components) words.add(c.name);
  }
  return [...words].filter(Boolean);
};
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <VoicePatchPanel
    v-if="patch"
    :patch-id="id"
    :from-candidates="voiceFrom"
    :to-candidates="voiceTo"
    :cable-candidates="cableCandidates"
    :vocabulary="vocabulary"
    @changed="load"
  />
</template>
