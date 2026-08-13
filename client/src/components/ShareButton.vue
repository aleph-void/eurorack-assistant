<script setup>
// "Who can see this" for one record: the button that says whether anything is
// shared, and the dialog behind it that says with whom.
//
// Sharing is read-only in both directions — the people you name can read what
// you made and nothing else, and you can take it back by clearing the list —
// so the dialog is a plain list of recipients rather than a permissions
// matrix. The state lives here rather than in the pages that use it: five
// different kinds of record share the same control.

import { computed, ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  // 'note' | 'patch' | 'question' | 'rack' | 'document'
  type: { type: String, required: true },
  id: { type: [Number, String], required: true },
  // What to call the thing in the dialog's heading.
  label: { type: String, default: '' },
  // Rendered as a small inline button next to other row actions.
  small: { type: Boolean, default: false },
});

const emit = defineEmits(['changed']);

// The component renders the button AND (when open) the dialog beside it, so
// there is no single root for Vue to put a caller's class or style on. They
// belong to the button.
defineOptions({ inheritAttrs: false });

const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const users = ref([]);
const everyone = ref(false);
// Recipient ids as a Set is what the checkboxes want; the API takes an array.
const chosen = ref(new Set());
// What the button shows without being opened, so a page full of records says
// at a glance which of them are out in the world.
const state = ref(null);

const path = computed(() => `/api/shares/${props.type}/${props.id}`);

const summary = computed(() => {
  if (!state.value) return 'Share';
  if (state.value.everyone) return 'Shared with everyone';
  const count = state.value.users.length;
  if (count === 0) return 'Share';
  return count === 1 ? `Shared with ${state.value.users[0].username}` : `Shared with ${count} people`;
});

const isShared = computed(() => Boolean(state.value?.everyone || state.value?.users.length));

function apply(share) {
  state.value = share;
  everyone.value = share.everyone;
  chosen.value = new Set(share.users.map((u) => u.id));
}

// The current state is fetched when the dialog opens rather than on mount: a
// list of thirty notes should not open with thirty requests.
async function openDialog() {
  open.value = true;
  error.value = '';
  loading.value = true;
  try {
    const [directory, share] = await Promise.all([api.get('/api/shares/users'), api.get(path.value)]);
    users.value = directory;
    apply(share);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function toggle(userId) {
  const next = new Set(chosen.value);
  if (next.has(userId)) next.delete(userId);
  else next.add(userId);
  chosen.value = next;
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    apply(await api.put(path.value, { everyone: everyone.value, user_ids: [...chosen.value] }));
    open.value = false;
    emit('changed', state.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function stopSharing() {
  error.value = '';
  saving.value = true;
  try {
    apply(await api.delete(path.value));
    open.value = false;
    emit('changed', state.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

// Set from the outside by a page that already knows (the shares listing), so
// the button can show the state without asking.
defineExpose({ apply });
</script>

<template>
  <button
    v-bind="$attrs"
    type="button"
    :class="['share-button', isShared ? '' : 'secondary', small ? 'small' : '']"
    :data-test="`share-${type}-${id}`"
    :title="`Who can see this ${type}`"
    @click="openDialog"
  >
    {{ summary }}
  </button>

  <div
    v-if="open"
    class="modal-scrim"
    data-test="share-scrim"
    @click.self="open = false"
    @keydown.esc.stop="open = false"
  >
    <div class="modal" role="dialog" aria-modal="true" data-test="share-dialog">
      <h2>Share {{ label || type }}</h2>
      <p class="muted modal-message">
        People you share with can read this {{ type }}. Only you can change or delete it, and you
        can stop sharing at any time.
      </p>
      <p v-if="error" class="error" data-test="share-error">{{ error }}</p>
      <p v-if="loading" class="muted">Loading…</p>

      <template v-else>
        <label class="share-row">
          <input v-model="everyone" type="checkbox" data-test="share-everyone" />
          Everyone — including users added later
        </label>

        <p class="muted" style="margin: 0.8rem 0 0.2rem">Or pick people:</p>
        <div class="share-list">
          <label v-for="u in users" :key="u.id" class="share-row">
            <input
              type="checkbox"
              :checked="chosen.has(u.id)"
              :data-test="`share-user-${u.id}`"
              @change="toggle(u.id)"
            />
            {{ u.username }}
          </label>
          <p v-if="users.length === 0" class="muted">
            There is nobody else to share with yet.
          </p>
        </div>

        <div class="modal-actions">
          <button class="secondary" type="button" data-test="share-cancel" @click="open = false">
            Cancel
          </button>
          <button
            v-if="isShared"
            class="danger"
            type="button"
            :disabled="saving"
            data-test="share-stop"
            @click="stopSharing"
          >
            Stop sharing
          </button>
          <button type="button" :disabled="saving" data-test="share-save" @click="save">Save</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.share-button.small {
  margin: 0;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
}
.share-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.3rem 0;
  color: var(--text);
  font-size: 0.95rem;
}
.share-row input {
  width: auto;
  margin: 0;
}
.share-list {
  max-height: 14rem;
  overflow-y: auto;
}
</style>
