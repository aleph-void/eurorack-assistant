<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ScopePanel from '../components/ScopePanel.vue';
import PatchNotesPanel from '../components/PatchNotesPanel.vue';
import PatchDiagram from '../components/PatchDiagram.vue';
import ShareButton from '../components/ShareButton.vue';
import VoicePatchPanel from '../components/VoicePatchPanel.vue';
import CablesSection from '../components/patchdetail/CablesSection.vue';
import FlowSection from '../components/patchdetail/FlowSection.vue';
import NormalledSection from '../components/patchdetail/NormalledSection.vue';
import SettingsSection from '../components/patchdetail/SettingsSection.vue';
import LinksSection from '../components/patchdetail/LinksSection.vue';
import GroupsSection from '../components/patchdetail/GroupsSection.vue';
import ExtrasSection from '../components/patchdetail/ExtrasSection.vue';
import {
  FROM_TYPES,
  TO_TYPES,
  usePatchFacts,
} from '../components/patchdetail/usePatchFacts.js';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

// A capture files itself under a note on this patch, so the notes panel is
// refreshed when one is taken.
const notesPanel = ref(null);
const onCaptured = () => notesPanel.value?.load();

const patch = ref(null);
const error = ref('');

const { modules, modulesById, groupsById, multiRack, moduleLabel, cables, jackCandidates } =
  usePatchFacts(patch);

const rackModules = ref([]);

// The diagram's drag gesture creates a cable exactly like the cable form
// does, so the write (and its error display) lives in the cables section.
const cablesSection = ref(null);
const connectDiagramCable = (ends) => cablesSection.value?.connectCable(ends);

// ---- renaming ----
const renaming = ref(false);
const renameValue = ref('');
const renameError = ref('');

// Cables worth plugging next, learned from the user's other patches.
const suggestions = ref([]);

async function loadSuggestions() {
  try {
    const res = await api.get(`/api/patches/${props.id}/suggestions`);
    suggestions.value = res?.suggestions ?? [];
  } catch {
    suggestions.value = [];
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
        patch.value.system_name ? `system '${patch.value.system_name}'` : `rack '${patch.value.rack_name}'`
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

async function load() {
  try {
    const loaded = await api.get(`/api/patches/${props.id}`);
    // Somebody else's patch, shared with you: this page is an editor and none
    // of it would work, so the read-only page is where that belongs.
    if (loaded.shared) {
      router.replace(`/shared/patch/${props.id}`);
      return;
    }
    patch.value = loaded;
    await loadSuggestions();
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

// Copy the whole patch: the same instances, cables, settings and buses under
// a new name, as the starting point for the next version of it.
const duplicating = ref(false);

async function duplicatePatch() {
  error.value = '';
  duplicating.value = true;
  try {
    const copy = await api.post(`/api/patches/${props.id}/clone`, {});
    router.push(`/patches/${copy.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    duplicating.value = false;
  }
}

// ---- the same two lists, said out loud ----
// Voice needs the ends kept whole rather than parsed from one line, the
// cables already plugged (so they can be pulled out by name), and the words
// this rack uses — a recogniser has never heard of Mimeophon and does better
// when it is told the names it should expect.
const voiceFrom = computed(() => jackCandidates(FROM_TYPES, false));
const voiceTo = computed(() => jackCandidates(TO_TYPES, true));
const cableCandidates = computed(() =>
  cables.value.map((c) => ({
    cable_id: c.id,
    module_label: `${moduleLabel(modulesById.value.get(c.from_patch_module_id))} ${c.from_component_name}`,
    jack_name: `${moduleLabel(modulesById.value.get(c.to_patch_module_id))} ${c.to_component_name}`,
  }))
);
const vocabulary = computed(() => {
  const words = new Set();
  for (const pm of modules.value) {
    words.add(pm.manufacturer);
    words.add(pm.module_name);
    if (pm.label) words.add(pm.label);
    for (const c of pm.components) words.add(c.name);
  }
  return [...words].filter(Boolean);
});

async function rename() {
  renameError.value = '';
  try {
    await api.put(`/api/patches/${props.id}`, { name: renameValue.value });
    renaming.value = false;
    await load();
  } catch (e) {
    renameError.value = e.message;
  }
}

onMounted(async () => {
  try {
    const list = await api.get('/api/modules');
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
});
</script>

<template>
  <p><RouterLink to="/patches">← All patches</RouterLink></p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <template v-if="patch">
    <template v-if="renaming">
      <form class="actions" @submit.prevent="rename">
        <input v-model="renameValue" data-test="rename-input" />
        <button type="submit" data-test="rename-save">Save</button>
        <button type="button" @click="renaming = false">Cancel</button>
      </form>
      <p v-if="renameError" class="error">{{ renameError }}</p>
    </template>
    <!-- The title and its small actions on one centered line: without the
         flex row the buttons baseline-align against the heading text and sit
         at odd heights beside it. -->
    <h1 v-else class="actions">
      {{ patch.name }}
      <button
        style="font-size: 0.8rem"
        data-test="rename"
        @click="renaming = true; renameValue = patch.name"
      >
        Rename
      </button>
      <button
        style="font-size: 0.8rem"
        class="secondary"
        :disabled="duplicating"
        data-test="duplicate-patch"
        @click="duplicatePatch"
      >
        Duplicate
      </button>
      <ShareButton :id="props.id" type="patch" :label="patch.name" small />
      <a
        :href="`/api/patches/${props.id}/export`"
        style="font-size: 0.8rem"
        data-test="export-patch"
        title="Download this patch as a JSON file"
      >
        Export JSON
      </a>
      <RouterLink
        :to="`/ask?patch=${props.id}`"
        style="font-size: 0.8rem"
        data-test="ask-about-patch"
      >
        Ask about this patch
      </RouterLink>
    </h1>
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

    <PatchDiagram
      :modules="modules"
      :cables="patch.cables"
      :label-for="moduleLabel"
      :rack-rows="patch.rack_layout"
      interactive
      @connect="connectDiagramCable"
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

    <VoicePatchPanel
      :patch-id="props.id"
      :from-candidates="voiceFrom"
      :to-candidates="voiceTo"
      :cable-candidates="cableCandidates"
      :vocabulary="vocabulary"
      @changed="load"
    />

    <CablesSection
      ref="cablesSection"
      :patch="patch"
      :patch-id="id"
      :suggestions="suggestions"
      @reload="load"
    />
    <FlowSection :patch="patch" />
    <NormalledSection :patch="patch" />
    <SettingsSection :patch="patch" :patch-id="id" @reload="load" />
    <LinksSection :patch="patch" :patch-id="id" @reload="load" />
    <GroupsSection :patch="patch" :patch-id="id" @reload="load" />
    <ExtrasSection :patch="patch" :patch-id="id" :rack-modules="rackModules" @reload="load" />

    <ScopePanel :patch-id="props.id" :modules="modules" @captured="onCaptured" />

    <PatchNotesPanel ref="notesPanel" :patch-id="props.id" />

    <details class="panel" data-test="snapshot">
      <summary>
        <h2>Modules in this patch</h2>
        <span class="summary-count">
          {{ modules.length }} {{ (modules.length) === 1 ? 'module' : 'modules' }}
        </span>
      </summary>
      <div class="panel-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th v-if="multiRack">Rack</th>
                <th>Bus</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pm in modules" :key="pm.id" :data-test="`patch-module-${pm.id}`">
                <td>
                  <RouterLink v-if="pm.live" :to="`/modules/${pm.module_id}`">
                    {{ moduleLabel(pm) }}
                  </RouterLink>
                  <template v-else>{{ moduleLabel(pm) }}</template>
                </td>
                <td v-if="multiRack">{{ pm.rack_name || '—' }}</td>
                <td>{{ groupsById.get(pm.group_id)?.name || '—' }}</td>
                <td>
                  <span
                    class="badge"
                    :class="pm.live ? 'found' : pm.external ? 'pending' : 'failed'"
                  >
                    {{
                      pm.live
                        ? 'in your system'
                        : pm.external
                          ? 'off-rack gear'
                          : 'no longer in your system'
                    }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </details>
  </template>
</template>
