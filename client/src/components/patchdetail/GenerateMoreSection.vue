<script setup>
// Have the model take THIS patch further: a brief saying what to add or
// change, and the total number of cables the patch may hold once it is done.
// The same generate_patch job a new patch is built with, run again over a
// patch that exists — a generated one to be refined, a hand-made one to be
// finished off, and, with the budget already met, a patch whose settings are
// to be dialed in over its traced signal flow. A patch is more than its
// connections, which is why this sits on the settings page as well as on
// the cables page.
import { computed, ref, watch } from 'vue';
import { api } from '../../api.js';
import { useLazyPanel } from '../../lazyPanel.js';

const props = defineProps({
  patch: { type: Object, required: true },
  patchId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

// How many more cables a refinement is offered by default, on top of what
// the patch already holds.
const MORE_CABLES = 6;
const CEILING = 200;

const { opened, onToggle } = useLazyPanel(false);
const brief = ref('');
// The budget is the TOTAL the patch may hold, and follows the cable count
// until the user types one of their own.
const cableCount = computed(() => (props.patch?.cables ?? []).length);
const maxCables = ref(Math.min(CEILING, cableCount.value + MORE_CABLES));
const touched = ref(false);
watch(cableCount, (n) => {
  if (!touched.value) maxCables.value = Math.min(CEILING, n + MORE_CABLES);
});
const busy = ref(false);
const error = ref('');
const notice = ref('');
// The instances to use: ones that must take part, or with `only` the only
// ones allowed (the patch's outputs stay available either way).
const chosen = ref([]);
const only = ref(false);
const instanceLabel = (pm) => {
  const base = `${pm.manufacturer || ''} ${pm.module_name || ''}`.trim() || 'unnamed module';
  const numbered = pm.instance > 1 ? `${base} #${pm.instance}` : base;
  return pm.label ? `${numbered} (${pm.label})` : numbered;
};

const settingsOnly = computed(() => Number(maxCables.value) <= cableCount.value);

async function generate() {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    await api.post(`/api/patches/${props.patchId}/generate`, {
      max_cables: Number(maxCables.value) || cableCount.value + MORE_CABLES,
      prompt: brief.value.trim() || undefined,
      ...(chosen.value.length
        ? { patch_module_ids: chosen.value.slice(), only_modules: only.value }
        : {}),
    });
    notice.value =
      'Queued — the model is working on it in the background (progress is on the Jobs page); ' +
      'this page updates when it finishes.';
    brief.value = '';
    emit('reload');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="panel" data-test="generate-more-section" @toggle="onToggle">
    <summary><h2>Take it further with the model</h2></summary>
    <template v-if="opened">
      <p class="muted">
        Say what to add or change — "more modulation", "route the delay into the mix", "set it up
        as a slow drone" — and how many cables the patch may hold in all once it is done. The model
        reads the patch as it stands, traced, adds cables within that budget (each one checked
        against the same rules as one you plug by hand) and then goes through every module it uses
        to dial in the controls and menu settings the patch depends on. Leave the budget at the
        current cable count to have only the settings reviewed.
      </p>
      <p v-if="error" class="error" data-test="generate-more-error">{{ error }}</p>
      <p v-if="notice" class="success" data-test="generate-more-notice">{{ notice }}</p>
      <form @submit.prevent="generate">
        <details class="module-picker" data-test="generate-more-modules">
          <summary>
            Choose modules
            <span v-if="chosen.length" class="muted" data-test="generate-more-modules-count">
              — {{ chosen.length }} chosen{{ only ? ', and only those' : '' }}
            </span>
            <span v-else class="muted">(optional — the whole patch otherwise)</span>
          </summary>
          <div class="module-choices">
            <label v-for="pm in patch.modules || []" :key="pm.id" class="module-choice">
              <input
                v-model="chosen"
                type="checkbox"
                :value="pm.id"
                :data-test="`generate-more-module-${pm.id}`"
              />
              {{ instanceLabel(pm) }}
            </label>
          </div>
          <label class="module-choice">
            <input v-model="only" type="checkbox" data-test="generate-more-only" :disabled="!chosen.length" />
            Use only these modules (the outputs stay available)
          </label>
        </details>
        <div class="row">
          <textarea
            v-model="brief"
            data-test="generate-more-brief"
            rows="2"
            maxlength="2000"
            placeholder="What should change? (optional)"
            style="flex: 3"
          ></textarea>
          <div class="shrink">
            <label for="generate-more-max" class="inline-label">Cables in all</label>
            <input
              id="generate-more-max"
              v-model="maxCables"
              type="number"
              :min="1"
              :max="CEILING"
              step="1"
              class="max-cables"
              data-test="generate-more-max"
              @input="touched = true"
            />
          </div>
          <div class="shrink">
            <button
              type="submit"
              style="margin: 0"
              :disabled="busy || patch.generating || Number(maxCables) < 1"
              :title="patch.generating ? 'The model is already working on this patch' : ''"
              data-test="generate-more"
            >
              {{ patch.generating ? 'Generating…' : settingsOnly ? 'Review settings' : 'Generate' }}
            </button>
          </div>
        </div>
      </form>
    </template>
  </details>
</template>

<style scoped>
.module-picker {
  margin: 0.25rem 0 0.75rem;
}

.module-picker summary {
  cursor: pointer;
}

.module-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin: 0.5rem 0;
}

.module-choice {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-weight: normal;
}

.inline-label {
  display: inline-block;
  margin: 0 0.4rem 0 0;
}

.max-cables {
  width: 5.5rem;
}
</style>
