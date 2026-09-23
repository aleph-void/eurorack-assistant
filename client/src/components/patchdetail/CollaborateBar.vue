<script setup>
// Patching WITH the model, one cable each. Switched on here, the model
// answers every cable plugged into this patch — on the picture below, on the
// cable list or by voice — with exactly one of its own, steered by the brief
// typed here (`PUT /api/patches/:id/collaboration`, services/patchTurn.js).
// The mode and the brief are facts about the patch and live on its row, so
// they are the same on every page and every device.
//
// The bar says whose move it is: the model's while its turn is on the queue
// (`patch.generating`, which the page re-reads on when the job lands), the
// user's otherwise — and what the model last did, read off the job feed,
// because the picture shows the cable and not the reason the model gave.
import { computed, ref, watch } from 'vue';
import { api } from '../../api.js';
import { useJobsStore } from '../../stores/jobs.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
// The server's answer — the record's `collaboration` — for the page to fold
// into its payload rather than re-reading a whole-studio patch for a flag.
const emit = defineEmits(['collaboration']);

const enabled = computed(() => Boolean(props.patch?.collaboration?.enabled));
const saved = computed(() => props.patch?.collaboration?.prompt ?? '');
// The brief as typed: a draft until Save, and the saved one otherwise.
const brief = ref(saved.value);
const dirty = ref(false);
watch(saved, (value) => {
  if (!dirty.value) brief.value = value;
});
const busy = ref(false);
const error = ref('');

async function write(body) {
  error.value = '';
  busy.value = true;
  try {
    const { collaboration } = await api.put(`/api/patches/${props.patchId}/collaboration`, body);
    emit('collaboration', collaboration);
    dirty.value = false;
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}

// Switching on saves the brief as typed with it, so one gesture starts the
// game; switching off leaves the brief where it is for next time.
function toggle(event) {
  const on = event.target.checked;
  write(on ? { enabled: true, prompt: brief.value.trim() } : { enabled: false });
}

const saveBrief = () => write({ prompt: brief.value.trim() });

// The model's last move on THIS patch, as its job said it: the finished
// job's line, or why a turn could not be taken. Only what this page has seen
// since it opened — which is when the two of you are patching.
const jobs = useJobsStore();
const lastMove = computed(() => {
  const id = Number(props.patchId);
  return (
    jobs.feed.find(
      (line) =>
        line.type === 'patch_turn' &&
        line.patchId === id &&
        (line.event === 'completed' || line.event === 'failed')
    ) ?? null
  );
});
</script>

<template>
  <div class="panel collaborate" data-test="collaborate">
    <div class="actions">
      <label class="toggle">
        <input
          type="checkbox"
          :checked="enabled"
          :disabled="busy"
          data-test="collaborate-toggle"
          @change="toggle"
        />
        Take turns with the model
      </label>
      <span v-if="!enabled" class="muted" data-test="collaborate-hint">
        — you plug a cable, the model answers with one of its own.
      </span>
      <span v-else-if="patch.generating" class="badge running" data-test="collaborate-turn">
        the model's turn…
      </span>
      <span v-else class="muted" data-test="collaborate-turn">
        Your move — plug a cable on the picture and the model answers with one.
      </span>
    </div>
    <template v-if="enabled">
      <form class="actions brief" @submit.prevent="saveBrief">
        <input
          v-model="brief"
          type="text"
          maxlength="2000"
          placeholder="What are the two of you making? (optional — 'a slow drone', 'keep it percussive')"
          data-test="collaborate-brief"
          @input="dirty = true"
        />
        <button type="submit" class="secondary" :disabled="busy || !dirty" data-test="collaborate-save">
          Save brief
        </button>
      </form>
      <p
        v-if="lastMove"
        :class="lastMove.event === 'failed' ? 'error' : 'muted'"
        data-test="collaborate-last"
      >
        The model{{ lastMove.event === 'failed' ? ' could not move: ' : ' ' }}{{ lastMove.message }}
      </p>
    </template>
    <p v-if="error" class="error" data-test="collaborate-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.collaborate {
  padding: 0.7rem 1rem;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  margin: 0;
}

.brief {
  margin-top: 0.5rem;
}

.brief input {
  flex: 1;
  min-width: min(16rem, 100%);
}

.collaborate p {
  margin: 0.5rem 0 0;
}
</style>
