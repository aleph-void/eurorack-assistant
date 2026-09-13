<script setup>
// The top of every composition page: which piece this is, and the handful
// of things about the piece as a whole — its name, what it is, the tempo.
import { ref } from 'vue';
import { api } from '../../api.js';

const props = defineProps({
  composition: { type: Object, default: null },
  compositionId: { type: String, required: true },
  error: { type: String, default: '' },
  // Set on the pages under the storyboard (a mapping onto a patch), so the
  // heading is a link back up to it.
  sub: { type: String, default: '' },
});
const emit = defineEmits(['reload']);

const editing = ref(false);
const name = ref('');
const description = ref('');
const tempo = ref('');
const editError = ref('');

function startEdit() {
  name.value = props.composition?.name ?? '';
  description.value = props.composition?.description ?? '';
  tempo.value = props.composition?.tempo_bpm ?? '';
  editError.value = '';
  editing.value = true;
}

async function save() {
  editError.value = '';
  try {
    await api.put(`/api/compositions/${props.compositionId}`, {
      name: name.value,
      description: description.value,
      tempo_bpm: tempo.value === '' ? null : tempo.value,
    });
    editing.value = false;
    emit('reload');
  } catch (e) {
    editError.value = e.message;
  }
}
</script>

<template>
  <p>
    <RouterLink to="/compositions">← All compositions</RouterLink>
    <template v-if="sub && composition">
      · <RouterLink :to="`/compositions/${compositionId}`" data-test="up-to-storyboard">
        {{ composition.name }}
      </RouterLink>
    </template>
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <template v-if="composition">
    <form v-if="editing" class="edit-form" data-test="composition-edit" @submit.prevent="save">
      <label for="composition-name">Name</label>
      <input id="composition-name" v-model="name" data-test="composition-name-input" />
      <label for="composition-description">What it is</label>
      <textarea
        id="composition-description"
        v-model="description"
        rows="3"
        data-test="composition-description-input"
      ></textarea>
      <label for="composition-tempo">Tempo (BPM)</label>
      <input
        id="composition-tempo"
        v-model="tempo"
        type="number"
        min="1"
        max="999"
        step="any"
        data-test="composition-tempo-input"
      />
      <p v-if="editError" class="error">{{ editError }}</p>
      <div class="actions">
        <button type="submit" data-test="composition-save">Save</button>
        <button type="button" class="secondary" @click="editing = false">Cancel</button>
      </div>
    </form>
    <template v-else>
      <h1 class="actions">
        <template v-if="sub">{{ sub }}</template>
        <template v-else>{{ composition.name }}</template>
        <button
          v-if="!sub"
          style="font-size: 0.8rem"
          type="button"
          data-test="composition-edit-button"
          @click="startEdit"
        >
          Edit
        </button>
      </h1>
      <p v-if="!sub && (composition.description || composition.tempo_bpm)" class="muted" data-test="composition-blurb">
        <span v-if="composition.tempo_bpm" class="badge">{{ composition.tempo_bpm }} BPM</span>
        {{ composition.description }}
      </p>
    </template>
  </template>
</template>

<style scoped>
.edit-form {
  max-width: 40rem;
  margin-bottom: 1rem;
}
</style>
