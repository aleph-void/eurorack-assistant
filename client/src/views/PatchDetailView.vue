<script setup>
// The picture of the patch: the case as it stood when the patch was made,
// with every cable drawn on it. Patching by dragging between two jacks
// happens here; the cable list, the voice panel and everything the patch is
// set up with are pages of their own, reached from the nav drawer.
import { ref, toRef } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import PatchDiagram from '../components/PatchDiagram.vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import { usePatchFacts } from '../components/patchdetail/usePatchFacts.js';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load, setCables } = usePatchRecord(toRef(props, 'id'));
const { modules, moduleLabel } = usePatchFacts(patch);

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
      :label-for="moduleLabel"
      :rack-rows="patch.rack_layout"
      interactive
      @connect="connectDiagramCable"
      @disconnect="disconnectDiagramCable"
      @retype="retypeDiagramJack"
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
