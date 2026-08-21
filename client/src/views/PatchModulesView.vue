<script setup>
// The modules the patch was built from, frozen as they stood when it was
// made: which rack each came from, which bus it plays in, and whether it is
// still in your system at all.
import { toRef } from 'vue';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import { usePatchFacts } from '../components/patchdetail/usePatchFacts.js';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const { patch, error, load } = usePatchRecord(toRef(props, 'id'));
const { modules, groupsById, multiRack, moduleLabel } = usePatchFacts(patch);
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <details v-if="patch" open class="panel" data-test="snapshot">
    <summary>
      <h2>Modules in this patch</h2>
      <span class="summary-count">
        {{ modules.length }} {{ modules.length === 1 ? 'module' : 'modules' }}
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
