<script setup>
// The one confirmation dialog for the whole app; see dialog.js for how views
// raise it. Nothing is rendered until a question is actually asked.
import { nextTick, ref, watch } from 'vue';
import { dialogState, settleConfirm } from '../dialog.js';

const confirmButton = ref(null);
const panel = ref(null);

// The action the user asked for is the one under the cursor when the dialog
// opens, so Enter answers it straight away.
watch(
  () => dialogState.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    confirmButton.value?.focus();
  }
);

// Tab stays inside the dialog: with only two buttons, wrapping at each end is
// the whole trap.
function onKeydown(event) {
  if (event.key === 'Escape') {
    // The drawer in App.vue also listens for Escape — closing the dialog is
    // the only thing that should happen here.
    event.stopPropagation();
    settleConfirm(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = panel.value?.querySelectorAll('button') ?? [];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div
    v-if="dialogState.open"
    class="modal-scrim"
    data-test="confirm-scrim"
    @click.self="settleConfirm(false)"
    @keydown="onKeydown"
  >
    <div
      ref="panel"
      class="modal"
      tabindex="-1"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      data-test="confirm-dialog"
    >
      <h2 id="confirm-title" data-test="confirm-title">{{ dialogState.title }}</h2>
      <p id="confirm-message" class="modal-message" data-test="confirm-message">
        {{ dialogState.message }}
      </p>
      <div class="modal-actions">
        <button class="secondary" type="button" data-test="confirm-cancel" @click="settleConfirm(false)">
          {{ dialogState.cancelLabel }}
        </button>
        <button
          ref="confirmButton"
          type="button"
          :class="dialogState.danger ? 'danger' : ''"
          data-test="confirm-ok"
          @click="settleConfirm(true)"
        >
          {{ dialogState.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
