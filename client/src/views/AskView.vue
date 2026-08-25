<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import AutocompleteSelect from '../components/AutocompleteSelect.vue';

const router = useRouter();
const route = useRoute();
const prompt = ref('');
const error = ref('');
const busy = ref(false);

// A question can be asked about one of the user's patches: what is plugged
// into what, how the controls are set and where the signal goes are attached
// to the question, and the patch's modules go into scope with it.
const patches = ref([]);
const patchId = ref('');
const patchOptions = computed(() =>
  patches.value.map((p) => ({
    value: p.id,
    label: p.name,
    hint: p.rack_name || undefined,
  }))
);

onMounted(async () => {
  try {
    // Nothing depends on this list arriving; a failure is not worth a toast.
    // The list endpoint pages; the picker asks for the biggest page there is,
    // so it holds the newest five hundred patches — a question is about a
    // patch on the bench, not one from years back.
    const page = await api.get('/api/patches?limit=500', { quiet: true });
    patches.value = Array.isArray(page?.patches) ? page.patches : [];
  } catch {
    patches.value = [];
  }
  // Arrived from a patch page's "Ask about this patch".
  const fromRoute = Number(route.query?.patch);
  if (Number.isInteger(fromRoute) && fromRoute > 0) patchId.value = fromRoute;
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const question = await api.post('/api/questions', {
      prompt: prompt.value,
      patch_id: patchId.value ? Number(patchId.value) : undefined,
    });
    router.push({ name: 'question-detail', params: { id: question.id } });
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h1>Ask about your system</h1>
  <div class="panel">
    <form @submit.prevent="submit">
      <label for="prompt">Question</label>
      <textarea
        id="prompt"
        v-model="prompt"
        data-test="prompt"
        placeholder="e.g. How do I patch a krell using Maths and my filters?"
      ></textarea>
      <div class="row">
        <div>
          <label for="ask-patch">About a patch (optional)</label>
          <AutocompleteSelect
            v-model="patchId"
            input-id="ask-patch"
            data-test="ask-patch"
            placeholder="Type a patch name…"
            empty-text="No patch matches"
            :options="patchOptions"
          />
        </div>
        <div v-if="patchId" class="shrink">
          <button type="button" class="secondary" data-test="ask-patch-clear" @click="patchId = ''">
            Clear
          </button>
        </div>
      </div>
      <p class="muted">
        The assistant first figures out which of your modules the question applies to. You then
        review that selection — adding modules, uploaded documents, previous answers, and notes —
        before the answer is generated. Naming a patch attaches its cables, control settings,
        normalled connections and signal flow to the question, and puts the modules it uses in
        scope.
      </p>
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <button type="submit" :disabled="busy || !prompt.trim()" data-test="submit">Ask</button>
    </form>
  </div>
</template>
