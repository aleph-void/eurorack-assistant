<script setup>
// The picture of the patch: the case as it stood when the patch was made,
// with every cable drawn on it. Patching by dragging between two jacks
// happens here; the cable list and everything the patch is set up with are
// pages of their own, reached from the nav drawer.
//
// This is also the page voice patching talks to. The listener is mounted over
// the whole app and switched on under the account rather than here, so what
// this page does is say which patch is on screen and how to name its jacks
// (`voicePatchTarget.js`); leaving takes the claim back.
import { onBeforeUnmount, ref, toRef, watch } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import PatchDiagram from '../components/PatchDiagram.vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import {
  FROM_TYPES,
  TO_TYPES,
  usePatchFacts,
} from '../components/patchdetail/usePatchFacts.js';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';
import { clearVoicePatch, setVoicePatch } from '../voicePatchTarget.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load, setCables } = usePatchRecord(toRef(props, 'id'));
const { modules, modulesById, moduleLabel, cables, jackCandidates } = usePatchFacts(patch);

// What voice patching needs to know about this patch. Every list is a
// FUNCTION: they are every jack and every cable in the patch — thousands of
// items on a system — and nothing reads them until somebody speaks.
let voiceClaim = 0;
function registerVoice() {
  voiceClaim = setVoicePatch(props.id, {
    label: patch.value?.name || '',
    from: () => jackCandidates(FROM_TYPES, false),
    to: () => jackCandidates(TO_TYPES, true),
    cables: () =>
      cables.value.map((c) => ({
        cable_id: c.id,
        module_label: `${moduleLabel(modulesById.value.get(c.from_patch_module_id))} ${c.from_component_name}`,
        jack_name: `${moduleLabel(modulesById.value.get(c.to_patch_module_id))} ${c.to_component_name}`,
      })),
    // A recogniser has never heard of Mimeophon and does better when it is
    // told the names to expect.
    vocabulary: () => {
      const words = new Set();
      for (const pm of modules.value) {
        words.add(pm.manufacturer);
        words.add(pm.module_name);
        if (pm.label) words.add(pm.label);
        for (const c of pm.components) words.add(c.name);
      }
      return [...words].filter(Boolean);
    },
    onChanged: load,
  });
}
// Registered on the way in, and again when the name arrives with the payload
// — the name is what the settings page says it is listening over. Registering
// twice is not a leak: each call takes the claim, and only the claim held at
// the end is the one given up.
watch(() => [props.id, patch.value?.name], registerVoice, { immediate: true });
onBeforeUnmount(() => clearVoicePatch(voiceClaim));

// The diagram's drag gesture creates and pulls out a cable exactly as the
// cable list does. The write lives here because this is the page the gesture
// happens on, and the diagram draws the cable the SERVER made rather than the
// one the pointer described — the rules that refuse a cable, and the second
// cable a stereo pair plugs, are the server's to decide. It is put straight
// into the payload instead of re-reading the patch: a studio's patch is a
// second of server work and two megabytes to read back, and a cable is one
// row of it.
const cableError = ref('');

async function connectDiagramCable(ends) {
  cableError.value = '';
  try {
    const { paired_cable: paired, ...cable } = await api.post(
      `/api/patches/${props.id}/cables`,
      ends
    );
    setCables([...patch.value.cables, cable, ...(paired ? [paired] : [])]);
  } catch (e) {
    cableError.value = e.message;
  }
}

// Moving a plug from one jack to another is an unplug and a re-plug in one
// gesture, so the server does it in one validated step: the old cable is only
// replaced once the new ends pass the same rules a fresh cable would, and a
// refused move leaves the patch exactly as it was. The row that comes back
// swaps in for the old one — the same no-second-read rule as plugging.
async function moveDiagramCable({ cable, ...ends }) {
  cableError.value = '';
  try {
    const moved = await api.post(`/api/patches/${props.id}/cables/${cable.id}/move`, ends);
    setCables([...patch.value.cables.filter((c) => c.id !== cable.id), moved]);
  } catch (e) {
    cableError.value = e.message;
  }
}

// Unplugging is not gated behind a modal: patching is done by plugging and
// unplugging over and over, and a cable is one drag away from being plugged
// again.
async function disconnectDiagramCable(cable) {
  cableError.value = '';
  try {
    await api.delete(`/api/patches/${props.id}/cables/${cable.id}`);
    setCables(patch.value.cables.filter((c) => c.id !== cable.id));
  } catch (e) {
    cableError.value = e.message;
  }
}

// Correcting which way a jack runs from the diagram. A jack's direction is a
// fact about the MODULE — the analysis reads a mult's jacks as plain inputs
// or outputs often enough that this is worth fixing where it shows — so the
// write goes to the module and every patch drawing it follows.
async function retypeDiagramJack({ module_id: moduleId, component_id: componentId, type }) {
  if (!moduleId) return;
  try {
    await api.put(`/api/modules/${moduleId}/components/${componentId}`, { type });
    await load();
  } catch {
    // api.js has already said so, in red, over the page.
  }
}

// A setting recorded from the picture — a menu parameter picked from the
// module menu, or a control's position from its marker — is the same PUT the
// settings page makes. Unlike a cable, a setting can flip a conditional
// normalled connection or a switched mult, so the patch is re-read rather
// than patched in place.
async function setDiagramSetting(body) {
  try {
    await api.put(`/api/patches/${props.id}/settings`, body);
    await load();
  } catch {
    // api.js has already said so, in red, over the page.
  }
}

// Catch the patch up with the racks it stands in. A patch draws the studio
// as it stood when it was made, so this is the only thing that ever changes
// its arrangement — asked for, never quietly.
const resyncing = ref(false);
async function resyncLayout() {
  const ok = await dialog.confirm({
    title: 'Match the current rack layout',
    message:
      `Redraw '${patch.value.name}' the way ${
        patch.value.system_name
          ? `system '${patch.value.system_name}'`
          : `rack '${patch.value.rack_name}'`
      } is organised now? The patch keeps its cables — only the arrangement of the panels changes.`,
    confirmLabel: 'Match layout',
  });
  if (!ok) return;
  resyncing.value = true;
  error.value = '';
  try {
    await api.post(`/api/patches/${props.id}/rack-layout/resync`);
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    resyncing.value = false;
  }
}
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <template v-if="patch">
    <p v-if="patch.system_id" class="muted" data-test="snapshot-note">
      Snapshot of every rack in system '{{ patch.system_name }}' as of
      {{ new Date(patch.created_at).toLocaleString() }} — a cable may run from any jack on any of
      those racks to any jack on any other, and later changes to the racks do not affect this
      patch.
    </p>
    <p v-else class="muted" data-test="snapshot-note">
      Snapshot of rack '{{ patch.rack_name }}' as of
      {{ new Date(patch.created_at).toLocaleString() }} — later changes to the rack do not affect
      this patch.
    </p>
    <p v-if="patch.description" style="white-space: pre-wrap">{{ patch.description }}</p>
    <p v-if="cableError" class="error" data-test="cable-error">{{ cableError }}</p>

    <PatchDiagram
      :modules="modules"
      :cables="patch.cables"
      :switches="patch.switches || []"
      :mults="patch.mults || []"
      :settings="patch.settings"
      :label-for="moduleLabel"
      :rack-rows="patch.rack_layout"
      interactive
      @connect="connectDiagramCable"
      @disconnect="disconnectDiagramCable"
      @move="moveDiagramCable"
      @retype="retypeDiagramJack"
      @setting="setDiagramSetting"
    />

    <p class="muted" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap">
      The panels are arranged the way the rack was when this patch was made.
      <button
        class="secondary"
        style="margin: 0"
        :disabled="resyncing"
        data-test="resync-layout"
        @click="resyncLayout"
      >
        Match the rack's layout now
      </button>
    </p>
  </template>
</template>
