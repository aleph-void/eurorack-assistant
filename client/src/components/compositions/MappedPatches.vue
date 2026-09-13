<script setup>
// The patches this composition is mapped onto, and the picker that maps it
// onto another. A piece can be performed on more than one patch — the
// small case, the whole studio, last year's version of either — and each
// pairing is its own record with its own bindings and notes.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';

const props = defineProps({
  composition: { type: Object, required: true },
  compositionId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const router = useRouter();
const patches = ref([]);
const chosen = ref('');
const error = ref('');
const busy = ref(false);

const mapped = computed(() => props.composition.patches || []);
const mappedIds = computed(() => new Set(mapped.value.map((r) => r.patch_id)));
// The user's patches not yet performing this piece. The biggest page there
// is, rather than the whole library: a picker of five hundred is already
// more than anyone scrolls.
const candidates = computed(() => patches.value.filter((p) => !mappedIds.value.has(p.id)));

onMounted(async () => {
  try {
    const page = await api.get('/api/patches?limit=500', { quiet: true });
    patches.value = page?.patches ?? [];
  } catch {
    patches.value = [];
  }
});

async function mapOnto() {
  if (!chosen.value) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post(`/api/compositions/${props.compositionId}/patches`, {
      patch_id: Number(chosen.value),
    });
    router.push(`/compositions/${props.compositionId}/patches/${chosen.value}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function unmap(realization) {
  const ok = await dialog.confirm({
    title: 'Unmap patch',
    message: `Stop mapping '${props.composition.name}' onto '${realization.patch_name}'? Every binding of an element to that patch is lost; the patch itself is untouched.`,
    confirmLabel: 'Unmap',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.delete(`/api/compositions/${props.compositionId}/patches/${realization.patch_id}`);
    emit('reload');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="panel" data-test="mapped-patches">
    <h2>Patches that perform it</h2>
    <p class="muted">
      The storyboard names no hardware. Mapping it onto a patch is where each part is bound to the
      module, control, bus or cable that plays it there — and a piece can be mapped onto more than
      one patch.
    </p>
    <p v-if="error" class="error" data-test="mapped-error">{{ error }}</p>
    <p v-if="!mapped.length" class="muted" data-test="no-mapped-patches">
      Not mapped onto any patch yet.
    </p>
    <div v-else class="table-wrap">
      <table data-test="mapped-table">
        <thead>
          <tr>
            <th>Patch</th>
            <th>Coverage</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in mapped" :key="r.id" :data-test="`mapped-${r.patch_id}`">
            <td data-label="Patch">
              <RouterLink :to="`/compositions/${compositionId}/patches/${r.patch_id}`">
                {{ r.patch_name }}
              </RouterLink>
              <span class="muted"> — {{ r.system_name || r.rack_name }}</span>
            </td>
            <td data-label="Coverage">
              <span
                class="badge"
                :class="{ complete: r.element_count > 0 && r.mapped_element_count === r.element_count }"
              >
                {{ r.mapped_element_count }} of {{ r.element_count }} parts mapped
              </span>
            </td>
            <td data-label="Notes"><span class="muted">{{ r.notes }}</span></td>
            <td>
              <div class="actions">
                <RouterLink :to="`/patches/${r.patch_id}`" class="secondary">Open patch</RouterLink>
                <button type="button" class="danger" data-test="unmap" @click="unmap(r)">Unmap</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <form class="actions map-form" data-test="map-form" @submit.prevent="mapOnto">
      <label for="map-patch">Map onto a patch</label>
      <select id="map-patch" v-model="chosen" data-test="map-patch">
        <option value="">Choose a patch…</option>
        <option v-for="p in candidates" :key="p.id" :value="p.id">
          {{ p.name }} — {{ p.system_name || p.rack_name }}
        </option>
      </select>
      <button type="submit" :disabled="busy || !chosen" data-test="map-submit">Map</button>
    </form>
  </div>
</template>

<style scoped>
.map-form {
  margin-top: 1rem;
}
</style>
