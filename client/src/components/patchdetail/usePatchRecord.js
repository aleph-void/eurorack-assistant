import { onMounted, shallowRef, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api.js';
import { useJobsStore } from '../../stores/jobs.js';

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

  // One write folded into the payload rather than read back. Re-reading the
  // record is the rule — it is what keeps every page showing what the server
  // really holds — but a whole-studio patch is a second of server work and
  // two megabytes on the wire, and paying that for a cable is what made a
  // patched cable take that long to appear. Cables are their own list in the
  // payload and nothing else the picture draws is made of them, so the page
  // that plugs one takes the row the server just made and puts it in place.
  // `extras` are the other fields the same answer settled — whether the
  // model is now at work on the patch (`generating`), which the cable route
  // says when plugging the cable queued the model's turn.
  function setCables(cables, extras = {}) {
    if (!patch.value) return;
    patch.value = { ...patch.value, cables, ...extras };
  }

  // Fields of the record itself that a small write answers with — switching
  // collaboration mode on or off is one boolean and a line of text, and the
  // server's answer already holds the state the page shows.
  function setFields(extras) {
    if (!patch.value) return;
    patch.value = { ...patch.value, ...extras };
  }

  onMounted(load);
  watch(id, load);

  // A patch the model is still wiring up (`generating`, a generate_patch
  // job of the owner's — or, in collaboration mode, the model's turn) fills
  // in when that job lands, so the page re-reads
  // itself when a job ENDS — and only while the payload says one is at it:
  // a whole-studio patch is a second of server work, and every other job
  // that ends is somebody's manual being analyzed, which changes nothing
  // here.
  const jobs = useJobsStore();
  watch(
    () => jobs.finished,
    () => {
      if (patch.value?.generating) load();
    }
  );

  return { patch, error, load, setCables, setFields };
}
