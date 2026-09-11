import { onMounted, ref, shallowRef, watch } from 'vue';
import { api } from '../../api.js';

// A composition's pages each read the same `GET /api/compositions/:id` and
// reload it after every write, the way a patch's pages do
// (patchdetail/usePatchRecord.js). Held in a shallowRef: nothing writes into
// the payload, every page asks the server for a fresh one.
export function useCompositionRecord(id) {
  const composition = shallowRef(null);
  const error = ref('');

  async function load() {
    error.value = '';
    try {
      composition.value = await api.get(`/api/compositions/${id.value}`);
    } catch (e) {
      error.value = e.message;
    }
  }

  onMounted(load);
  watch(id, load);

  return { composition, error, load };
}
