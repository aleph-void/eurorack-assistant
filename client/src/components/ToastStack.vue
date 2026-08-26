<script setup>
// The app's toasts, mounted once in App.vue; see toast.js for how anything
// raises one. Nothing is rendered until something has been said.
import { dismissToast, holdToast, releaseToast, toastState } from '../toast.js';

const ICONS = { success: '✓', error: '✕', info: 'i', warning: '!' };
</script>

<template>
  <!-- aria-live rather than role=alert on the region: a completed job is
       announced when the reader next pauses, an error (role=alert on the
       toast itself) interrupts. -->
  <div class="toast-stack" role="status" aria-live="polite" data-test="toast-stack">
    <TransitionGroup name="toast">
      <div
        v-for="item in toastState.items"
        :key="item.id"
        class="toast"
        :class="`toast-${item.kind}`"
        :role="item.kind === 'error' || item.kind === 'warning' ? 'alert' : undefined"
        :data-test="`toast-${item.kind}`"
        @mouseenter="holdToast(item.id)"
        @mouseleave="releaseToast(item.id)"
        @focusin="holdToast(item.id)"
        @focusout="releaseToast(item.id)"
      >
        <span class="toast-icon" aria-hidden="true">{{ ICONS[item.kind] }}</span>
        <div class="toast-body">
          <p v-if="item.title" class="toast-title">
            {{ item.title }}
            <span v-if="item.count > 1" class="toast-count">×{{ item.count }}</span>
          </p>
          <p class="toast-message">
            {{ item.message }}
            <span v-if="item.count > 1 && !item.title" class="toast-count">×{{ item.count }}</span>
          </p>
        </div>
        <button
          type="button"
          class="toast-close"
          aria-label="Dismiss"
          :data-test="`toast-dismiss-${item.id}`"
          @click="dismissToast(item.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
