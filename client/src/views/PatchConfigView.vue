<script setup>
// Everything about a patch that is not the picture of it.
//
// The patch view is for patching: the diagram, the cable list and the voice
// panel. The rest — what each control is dialled to, the buses instances play
// in, the gear the rack does not hold, the scope, the notes — is set up once
// and read rarely, so it lives here rather than in the way. Both pages read
// the same `GET /api/patches/:id` and reload it after every write.
import { onMounted, ref, shallowRef } from 'vue';
import { api } from '../api.js';
import ScopePanel from '../components/ScopePanel.vue';
import PatchNotesPanel from '../components/PatchNotesPanel.vue';
import FlowSection from '../components/patchdetail/FlowSection.vue';
import NormalledSection from '../components/patchdetail/NormalledSection.vue';
import SettingsSection from '../components/patchdetail/SettingsSection.vue';
import LinksSection from '../components/patchdetail/LinksSection.vue';
import GroupsSection from '../components/patchdetail/GroupsSection.vue';
import ExtrasSection from '../components/patchdetail/ExtrasSection.vue';
import { usePatchFacts } from '../components/patchdetail/usePatchFacts.js';
import { useLazyPanel } from '../lazyPanel.js';

const props = defineProps({ id: { type: String, required: true } });

// Held shallow: a patch of a whole studio is thousands of components, none of
// which this page writes into (see PatchDetailView).
const patch = shallowRef(null);
const error = ref('');

const { modules, groupsById, multiRack, moduleLabel } = usePatchFacts(patch);

// The snapshot table is a row per instance — a couple of hundred of them for
// a system — and starts closed, so it is built when it is first opened.
const { opened: snapshotOpen, onToggle: onSnapshotToggle } = useLazyPanel();

// A capture files itself under a note on this patch, so the notes panel is
// refreshed when one is taken.
const notesPanel = ref(null);
const onCaptured = () => notesPanel.value?.load();

// The modules of the rack, offered when declaring gear the patch invented.
const rackModules = ref([]);

async function load() {
  try {
    patch.value = await api.get(`/api/patches/${props.id}`);
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

onMounted(async () => {
  try {
    const list = await api.get('/api/modules', { quiet: true });
    rackModules.value = Array.isArray(list) ? list : [];
  } catch {
    rackModules.value = [];
  }
});
</script>

<template>
  <p>
    <RouterLink :to="`/patches/${props.id}`" data-test="back-to-patch">← Back to the patch</RouterLink>
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <template v-if="patch">
    <h1>{{ patch.name }} — configuration</h1>
    <p class="muted">
      How this patch is set up: what the controls are dialled to, the buses its
      instances play in, the gear beyond the rack, and what the scope is watching.
      Patch cables on <RouterLink :to="`/patches/${props.id}`">the patch itself</RouterLink>.
    </p>

    <FlowSection :patch="patch" />
    <NormalledSection :patch="patch" />
    <SettingsSection :patch="patch" :patch-id="id" @reload="load" />
    <LinksSection :patch="patch" :patch-id="id" @reload="load" />
    <GroupsSection :patch="patch" :patch-id="id" @reload="load" />
    <ExtrasSection :patch="patch" :patch-id="id" :rack-modules="rackModules" @reload="load" />

    <ScopePanel :patch-id="props.id" :modules="modules" @captured="onCaptured" />

    <PatchNotesPanel ref="notesPanel" :patch-id="props.id" />

    <details class="panel" data-test="snapshot" @toggle="onSnapshotToggle">
      <summary>
        <h2>Modules in this patch</h2>
        <span class="summary-count">
          {{ modules.length }} {{ (modules.length) === 1 ? 'module' : 'modules' }}
        </span>
      </summary>
      <div v-if="snapshotOpen" class="panel-body">
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
