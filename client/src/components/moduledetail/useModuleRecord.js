import { onMounted, ref, shallowRef, watch } from 'vue';
import { api } from '../../api.js';

// The list of the user's modules, shared by every module page in the session.
//
// It is not the record — it is what the header's previous/next links walk and
// what the expander and dual pickers offer — and it only changes when the set
// of modules does: an import, a module deleted, a rack deleted. It used to be
// re-read on every module page AND after every write to one, a second round
// trip behind the record each time, for a list that had not moved. So it is
// read once and kept, and the three places that change the set say so.
let listPromise = null;

export function refreshRackModules() {
  listPromise = null;
}

function rackModuleList() {
  if (!listPromise) {
    listPromise = api
      .get('/api/modules', { quiet: true })
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => {
        // Not cached as a failure: the next page to ask tries again.
        listPromise = null;
        return [];
      });
  }
  return listPromise;
}

// Every module page is its own route over the same record: each one reads
// `GET /api/modules/:id` and reloads it after every write, the contract the
// two patch pages have always had.
//
// The payload is held in a shallowRef, for the reason the patch payload is
// (usePatchRecord.js): a well-analyzed module is hundreds of components with
// their values, and a panel with a placement for each, and NOTHING writes
// into any of it — every writer replaces the object (`{ ...module.value,
// panel }`) or reloads the record. Deep reactivity over all of it doubles
// every render and buys nothing.
export function useModuleRecord(id) {
  const module = shallowRef(null);
  const error = ref('');
  const rackModules = ref([]);

  // What every writer on every module page calls: the record, and only the
  // record. Editing a component cannot change which modules are in the rack.
  async function load() {
    try {
      module.value = await api.get(`/api/modules/${id.value}`);
    } catch (e) {
      error.value = e.message;
    }
  }

  // Opening a page, or walking to the next module: the record and the list
  // together, in parallel — they are independent reads and waiting for one
  // before asking for the other made every module page two round trips deep.
  async function open() {
    const [, list] = await Promise.all([load(), rackModuleList()]);
    rackModules.value = list;
  }

  onMounted(open);
  watch(id, open);

  return { module, error, rackModules, load };
}
