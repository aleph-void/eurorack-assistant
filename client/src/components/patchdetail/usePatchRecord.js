import { onMounted, shallowRef, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api.js';

// Every patch page is its own route over the same record: each one reads
// `GET /api/patches/:id` and reloads it after every write.
//
// The payload is held in a shallowRef, never a deep one. A patch of a whole
// studio is thousands of components and panel placements, none of which any
// page writes into — every section reads it and asks the server for a fresh
// one — and making all of it deeply reactive doubles the cost of every
// render and triples the memory it sits in, buying nothing.
export function usePatchRecord(id) {
  const router = useRouter();
  const patch = shallowRef(null);
  const error = ref('');

  async function load() {
    try {
      const loaded = await api.get(`/api/patches/${id.value}`);
      // Somebody else's patch, shared with you: these pages are editors and
      // none of it would work, so the read-only page is where that belongs.
      if (loaded.shared) {
        router.replace(`/shared/patch/${id.value}`);
        return;
      }
      patch.value = loaded;
    } catch (e) {
      error.value = e.message;
    }
  }

  onMounted(load);
  watch(id, load);

  return { patch, error, load };
}
