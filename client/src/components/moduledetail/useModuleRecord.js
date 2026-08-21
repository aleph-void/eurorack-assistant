import { onMounted, ref, watch } from 'vue';
import { api } from '../../api.js';

// Every module page is its own route over the same record: each one reads
// `GET /api/modules/:id` and reloads it after every write, the contract the
// two patch pages have always had. The list of the user's modules rides
// along because the header's previous/next links and the expander and dual
// pickers are all drawn from it.
export function useModuleRecord(id) {
  const module = ref(null);
  const error = ref('');
  const rackModules = ref([]);

  async function load() {
    try {
      module.value = await api.get(`/api/modules/${id.value}`);
    } catch (e) {
      error.value = e.message;
    }
    try {
      const list = await api.get('/api/modules', { quiet: true });
      rackModules.value = Array.isArray(list) ? list : [];
    } catch {
      rackModules.value = [];
    }
  }

  onMounted(load);
  watch(id, load);

  return { module, error, rackModules, load };
}
