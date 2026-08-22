<script setup>
// The top of every patch page: which patch this is and the handful of things
// that are about the patch as a whole rather than about any one page of it.
// Drawn by all nine patch routes, so it is also what tells the nav drawer
// which patch's sub-pages to offer.
import { onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api.js';
import ShareButton from '../ShareButton.vue';
import { useDetailStore } from '../../stores/detail.js';

const props = defineProps({
  patch: { type: Object, default: null },
  patchId: { type: String, required: true },
  error: { type: String, default: '' },
});
const emit = defineEmits(['reload']);

const router = useRouter();
const detail = useDetailStore();

let claim = 0;
watch(
  () => [props.patchId, props.patch?.name],
  () => {
    claim = detail.set('patch', props.patchId, props.patch?.name || '');
  },
  { immediate: true }
);
onUnmounted(() => detail.clear(claim));

// ---- renaming ----
const renaming = ref(false);
const renameValue = ref('');
const renameError = ref('');

async function rename() {
  renameError.value = '';
  try {
    await api.put(`/api/patches/${props.patchId}`, { name: renameValue.value });
    renaming.value = false;
    emit('reload');
  } catch (e) {
    renameError.value = e.message;
  }
}

// Copy the whole patch: the same instances, cables, settings and buses under
// a new name, as the starting point for the next version of it.
const duplicating = ref(false);
const duplicateError = ref('');

async function duplicatePatch() {
  duplicateError.value = '';
  duplicating.value = true;
  try {
    const copy = await api.post(`/api/patches/${props.patchId}/clone`, {});
    router.push(`/patches/${copy.id}`);
  } catch (e) {
    duplicateError.value = e.message;
  } finally {
    duplicating.value = false;
  }
}
</script>

<template>
  <p><RouterLink to="/patches">← All patches</RouterLink></p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="duplicateError" class="error" data-test="duplicate-error">{{ duplicateError }}</p>
  <template v-if="patch">
    <template v-if="renaming">
      <form class="actions" @submit.prevent="rename">
        <input v-model="renameValue" data-test="rename-input" />
        <button type="submit" data-test="rename-save">Save</button>
        <button type="button" @click="renaming = false">Cancel</button>
      </form>
      <p v-if="renameError" class="error">{{ renameError }}</p>
    </template>
    <!-- The title and its small actions on one centered line: without the
         flex row the buttons baseline-align against the heading text and sit
         at odd heights beside it. -->
    <h1 v-else class="actions">
      {{ patch.name }}
      <button
        style="font-size: 0.8rem"
        data-test="rename"
        @click="renaming = true; renameValue = patch.name"
      >
        Rename
      </button>
      <button
        style="font-size: 0.8rem"
        class="secondary"
        :disabled="duplicating"
        data-test="duplicate-patch"
        @click="duplicatePatch"
      >
        Duplicate
      </button>
      <ShareButton :id="patchId" type="patch" :label="patch.name" small />
      <a
        :href="`/api/patches/${patchId}/export`"
        style="font-size: 0.8rem"
        data-test="export-patch"
        title="Download this patch as a JSON file"
      >
        Export JSON
      </a>
      <RouterLink
        :to="`/patches/${patchId}/questions`"
        style="font-size: 0.8rem"
        data-test="ask-about-patch"
      >
        Ask about this patch
      </RouterLink>
    </h1>
  </template>
</template>
