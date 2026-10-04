<script setup>
// The follow-ups asked under a question, in the order they were asked: each
// one with the answer it got, or the state it is in. The same list on the
// question's own page and on the page of a question shared with you — the
// box that asks the next one belongs to the owner's page alone, so it stays
// there.
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps({
  turns: { type: Array, default: () => [] },
  // Whether a turn may be taken out of the thread (the owner's page).
  removable: { type: Boolean, default: false },
});
const emit = defineEmits(['remove']);

const WORKING = ['scoping', 'scoped', 'pending', 'answering'];

// Each answer rendered once per payload rather than per render.
const rendered = computed(() =>
  props.turns.map((turn) => ({
    ...turn,
    working: WORKING.includes(turn.status),
    answerHtml: turn.answer ? DOMPurify.sanitize(marked.parse(turn.answer)) : '',
  }))
);
</script>

<template>
  <ol v-if="rendered.length > 0" class="thread" data-test="thread">
    <li v-for="turn in rendered" :key="turn.id" class="thread-turn" data-test="thread-turn">
      <p class="thread-prompt" data-test="thread-prompt">{{ turn.prompt }}</p>
      <p v-if="turn.working" class="muted" data-test="thread-pending">
        The assistant is working on this one…
      </p>
      <p v-else-if="turn.status === 'failed'" class="error" data-test="thread-error">
        Failed: {{ turn.error }}
      </p>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
      <div v-else-if="turn.answerHtml" class="answer" data-test="thread-answer" v-html="turn.answerHtml"></div>
      <p v-if="removable && !turn.working" class="actions thread-actions">
        <button
          type="button"
          class="secondary"
          :data-test="`remove-turn-${turn.id}`"
          @click="emit('remove', turn)"
        >
          Remove
        </button>
      </p>
    </li>
  </ol>
</template>
