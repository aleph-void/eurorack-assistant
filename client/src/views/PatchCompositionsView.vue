<script setup>
// The compositions this patch performs, from the patch's side: each one
// with how much of it is mapped here, and the picker that maps another
// onto this patch.
import { computed, onMounted, ref, toRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import PatchDetailHeader from '../components/patchdetail/PatchDetailHeader.vue';
import { usePatchRecord } from '../components/patchdetail/usePatchRecord.js';

const props = defineProps({ id: { type: String, required: true } });

const router = useRouter();
const { patch, error, load } = usePatchRecord(toRef(props, 'id'));

const performed = ref([]);
const all = ref([]);
const chosen = ref('');
const listError = ref('');
const busy = ref(false);

async function loadCompositions() {
  listError.value = '';
  try {
    const [onPatch, library] = await Promise.all([
      api.get(`/api/compositions?patch_id=${props.id}`),
      api.get('/api/compositions?limit=500', { quiet: true }).catch(() => null),
    ]);
    performed.value = onPatch?.compositions ?? [];
    all.value = library?.compositions ?? [];
  } catch (e) {
    listError.value = e.message;
  }
}

onMounted(loadCompositions);
watch(() => props.id, loadCompositions);

const performedIds = computed(() => new Set(performed.value.map((c) => c.id)));
const candidates = computed(() => all.value.filter((c) => !performedIds.value.has(c.id)));

async function mapOnto() {
  if (!chosen.value) return;
  listError.value = '';
  busy.value = true;
  try {
    await api.post(`/api/compositions/${chosen.value}/patches`, { patch_id: Number(props.id) });
    router.push(`/compositions/${chosen.value}/patches/${props.id}`);
  } catch (e) {
    listError.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PatchDetailHeader :patch="patch" :patch-id="id" :error="error" @reload="load" />
  <div v-if="patch" class="panel" data-test="patch-compositions">
    <h2>Compositions performed on this patch</h2>
    <p v-if="listError" class="error" data-test="compositions-error">{{ listError }}</p>
    <p v-if="!performed.length" class="muted" data-test="no-compositions">
      No composition is mapped onto this patch yet.
      <RouterLink to="/compositions">Write one</RouterLink>, or map one below.
    </p>
    <div v-else class="table-wrap">
      <table data-test="performed-table">
        <thead>
          <tr>
            <th>Composition</th>
            <th>Coverage</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in performed" :key="c.id" :data-test="`performed-${c.id}`">
            <td data-label="Composition">
              <RouterLink :to="`/compositions/${c.id}/patches/${id}`">{{ c.name }}</RouterLink>
              <span class="muted"> — {{ c.scene_count }} scenes, {{ c.element_count }} parts</span>
            </td>
            <td data-label="Coverage">
              <span class="badge" :class="{ complete: c.element_count > 0 && c.mapped_element_count === c.element_count }">
                {{ c.mapped_element_count }} of {{ c.element_count }} parts mapped
              </span>
            </td>
            <td data-label="Notes"><span class="muted">{{ c.notes }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <form class="actions map-form" data-test="map-form" @submit.prevent="mapOnto">
      <label for="map-composition">Map a composition onto this patch</label>
      <select id="map-composition" v-model="chosen" data-test="map-composition">
        <option value="">Choose a composition…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.name }}</option>
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
