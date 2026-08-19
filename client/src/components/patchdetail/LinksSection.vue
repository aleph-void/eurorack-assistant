<script setup>
import { computed, ref, toRef } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import { usePatchFacts } from './usePatchFacts.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const { modules, modulesById, moduleLabel } = usePatchFacts(toRef(props, 'patch'));

// ---- links between instances ----
const links = computed(() => props.patch?.links || []);
const linkA = ref('');
const linkB = ref('');
const linkKind = ref('bridge');
const linkError = ref('');

async function addLink() {
  linkError.value = '';
  try {
    await api.post(`/api/patches/${props.patchId}/links`, {
      a_patch_module_id: Number(linkA.value),
      b_patch_module_id: Number(linkB.value),
      kind: linkKind.value,
    });
    linkA.value = '';
    linkB.value = '';
    emit('reload');
  } catch (e) {
    linkError.value = e.message;
  }
}

async function removeLink(link) {
  const ok = await dialog.confirm({
    title: 'Remove link',
    message: `Remove the ${link.kind} link between these two instances?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  linkError.value = '';
  try {
    await api.delete(`/api/patches/${props.patchId}/links/${link.id}`);
    emit('reload');
  } catch (e) {
    linkError.value = e.message;
  }
}
</script>

<template>
  <details class="panel" data-test="links">
    <summary>
      <h2>Linked instances</h2>
      <span class="summary-count">
        {{ links.length }} {{ (links.length) === 1 ? 'link' : 'links' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Modules wired to each other without patch cables: a host and its expander panel, or a
        bridged pair carrying signals between two points of the system — where a signal patched
        into one panel comes out of the matching jack on the other.
      </p>
      <div v-if="links.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Modules</th>
              <th>Kind</th>
              <th>Bridged jacks</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="link in links" :key="link.id" :data-test="`link-${link.id}`">
              <td>
                {{ moduleLabel(modulesById.get(link.a_patch_module_id)) }} ↔
                {{ moduleLabel(modulesById.get(link.b_patch_module_id)) }}
              </td>
              <td>{{ link.kind }}</td>
              <td>
                {{
                  link.jacks.length
                    ? link.jacks.map((j) => `${j.a_component_name}↔${j.b_component_name}`).join(', ')
                    : '—'
                }}
              </td>
              <td>
                <button
                  class="danger"
                  style="margin: 0"
                  :data-test="`delete-link-${link.id}`"
                  @click="removeLink(link)"
                >
                  Unlink
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No linked instances in this patch.</p>

      <form @submit.prevent="addLink">
        <div class="row">
          <div>
            <label for="link-a">Module</label>
            <select id="link-a" v-model="linkA" data-test="link-a">
              <option value="" disabled>Select a module…</option>
              <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm) }}</option>
            </select>
          </div>
          <div>
            <label for="link-b">Linked to</label>
            <select id="link-b" v-model="linkB" data-test="link-b">
              <option value="" disabled>Select a module…</option>
              <option v-for="pm in modules" :key="pm.id" :value="pm.id">{{ moduleLabel(pm) }}</option>
            </select>
          </div>
          <div>
            <label for="link-kind">Kind</label>
            <select id="link-kind" v-model="linkKind" data-test="link-kind">
              <option value="bridge">Bridge — jacks pair up by name</option>
              <option value="expander">Expander panel</option>
            </select>
          </div>
          <div class="shrink">
            <button
              type="submit"
              style="margin: 0"
              :disabled="!linkA || !linkB || linkA === linkB"
              data-test="link-create"
            >
              Link
            </button>
          </div>
        </div>
        <p v-if="linkError" class="error" data-test="link-error">{{ linkError }}</p>
      </form>
    </div>
  </details>
</template>
