<script setup>
// A type-to-find picker: one text box that filters its options as you type,
// keeps the first match highlighted, moves the highlight with the arrow keys
// and takes the highlighted one on Enter or Tab.
//
// It stands in for a <select> everywhere a patch is built out of long lists —
// every module in a rack, every jack on a panel — where reading a dropdown is
// slower than typing the two letters that identify what you want.
//
// Options are { value, label, hint?, disabled? }. `hint` is shown beside the
// label and is searched along with it; a disabled option cannot be picked and
// the highlight steps over it.
import { computed, nextTick, ref, watch } from 'vue';

let uid = 0;

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Type to search…' },
  inputId: { type: String, default: undefined },
  dataTest: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  emptyText: { type: String, default: 'No matches' },
});
const emit = defineEmits(['update:modelValue', 'select']);

const query = ref('');
const open = ref(false);
const highlight = ref(-1);
const inputEl = ref(null);
const listEl = ref(null);

// Stable per instance: the ids that tie the input to its list for assistive
// technology (aria-controls / aria-activedescendant).
const listId = `ac-${(uid += 1)}`;

const same = (a, b) => String(a) === String(b);
const selectedOption = computed(
  () => props.options.find((o) => same(o.value, props.modelValue)) ?? null
);

// The box shows the chosen option while it is not being edited, including
// when the caller clears or changes the selection from the outside.
watch(
  () => [props.modelValue, props.options],
  () => {
    if (!open.value) query.value = selectedOption.value?.label ?? '';
  },
  { immediate: true }
);

const terms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean));
// While the box still reads as the current selection the user is re-picking,
// not filtering, so the whole list stays on offer.
const matches = computed(() => {
  if (terms.value.length === 0) return props.options;
  if (selectedOption.value && query.value === selectedOption.value.label) return props.options;
  return props.options.filter((o) => {
    const haystack = `${o.label} ${o.hint ?? ''}`.toLowerCase();
    return terms.value.every((t) => haystack.includes(t));
  });
});

const firstPickable = (from = 0, step = 1) => {
  for (let i = 0; i < matches.value.length; i += 1) {
    const index = (from + i * step + matches.value.length * matches.value.length) % matches.value.length;
    if (!matches.value[index].disabled) return index;
  }
  return -1;
};

// The first match leads, so a picker that has been narrowed to one answer
// takes a single Enter.
watch(matches, () => {
  highlight.value = firstPickable();
});

const activeId = computed(() =>
  open.value && highlight.value >= 0 ? `${listId}-${highlight.value}` : undefined
);

async function scrollHighlightIntoView() {
  await nextTick();
  const row = listEl.value?.children?.[highlight.value];
  row?.scrollIntoView?.({ block: 'nearest' });
}

function move(step) {
  if (matches.value.length === 0) return;
  const start = highlight.value < 0 ? (step > 0 ? -1 : 0) : highlight.value;
  const next = firstPickable(start + step, step);
  if (next >= 0) highlight.value = next;
  scrollHighlightIntoView();
}

function choose(option) {
  if (!option || option.disabled) return;
  query.value = option.label;
  open.value = false;
  if (!same(option.value, props.modelValue)) emit('update:modelValue', option.value);
  emit('select', option);
}

function onInput(event) {
  query.value = event.target.value;
  open.value = true;
  highlight.value = firstPickable();
  // Editing the text abandons the current choice: what the box says and what
  // the form will submit must never disagree.
  if (props.modelValue !== '' && query.value !== selectedOption.value?.label) {
    emit('update:modelValue', '');
  }
}

function onKeydown(event) {
  if (props.disabled) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!open.value) {
      open.value = true;
      highlight.value = firstPickable();
      scrollHighlightIntoView();
    } else {
      move(1);
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open.value) {
      open.value = true;
      highlight.value = firstPickable(matches.value.length - 1, -1);
      scrollHighlightIntoView();
    } else {
      move(-1);
    }
  } else if (event.key === 'Enter') {
    // Only swallow the Enter that picks an option — with the list closed it
    // submits the form, so a whole cable can be entered without the mouse.
    if (open.value && highlight.value >= 0) {
      event.preventDefault();
      choose(matches.value[highlight.value]);
    }
  } else if (event.key === 'Tab') {
    if (open.value && highlight.value >= 0) choose(matches.value[highlight.value]);
  } else if (event.key === 'Escape') {
    if (open.value) {
      event.preventDefault();
      close();
    }
  }
}

function close() {
  open.value = false;
  query.value = selectedOption.value?.label ?? '';
}

function onFocus(event) {
  open.value = true;
  highlight.value = firstPickable();
  // Typing over a made choice replaces it instead of appending to it.
  event.target.select?.();
}

defineExpose({
  focus: () => {
    inputEl.value?.focus();
    inputEl.value?.select?.();
  },
});
</script>

<template>
  <div class="ac">
    <input
      :id="inputId"
      ref="inputEl"
      class="ac-input"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="activeId"
      :value="query"
      :placeholder="placeholder"
      :disabled="disabled"
      :data-test="dataTest || undefined"
      @input="onInput"
      @keydown="onKeydown"
      @focus="onFocus"
      @blur="close"
    />
    <ul
      v-if="open"
      :id="listId"
      ref="listEl"
      class="ac-list"
      role="listbox"
      :data-test="dataTest ? `${dataTest}-list` : undefined"
    >
      <li
        v-for="(option, i) in matches"
        :id="`${listId}-${i}`"
        :key="option.value"
        class="ac-option"
        :class="{ 'ac-active': i === highlight, 'ac-disabled': option.disabled }"
        role="option"
        :aria-selected="i === highlight"
        :aria-disabled="option.disabled || undefined"
        :data-test="dataTest ? `${dataTest}-option-${option.value}` : undefined"
        @mousedown.prevent="choose(option)"
      >
        <span>{{ option.label }}</span>
        <span v-if="option.hint" class="ac-hint">{{ option.hint }}</span>
      </li>
      <li
        v-if="matches.length === 0"
        class="ac-option ac-empty"
        :data-test="dataTest ? `${dataTest}-empty` : undefined"
      >
        {{ emptyText }}
      </li>
    </ul>
  </div>
</template>
