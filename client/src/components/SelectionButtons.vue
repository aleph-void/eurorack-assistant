<script setup>
// The two buttons over a list of checkboxes: tick every row on screen, or
// untick every row on screen. They act on the rows the list is SHOWING (a
// filtered list, a list narrowed to the selected modules) and leave any
// selection the list is not showing alone, so 'Select none' under a filter
// clears what the filter matched and nothing else.
import { computed } from 'vue';

const props = defineProps({
  ids: { type: Array, required: true },
  modelValue: { type: Array, required: true },
  name: { type: String, default: 'selection' },
});
const emit = defineEmits(['update:modelValue']);

const shownSelected = computed(() => props.ids.filter((id) => props.modelValue.includes(id)));
const allSelected = computed(() => props.ids.length > 0 && shownSelected.value.length === props.ids.length);
const noneSelected = computed(() => shownSelected.value.length === 0);

function selectAll() {
  const missing = props.ids.filter((id) => !props.modelValue.includes(id));
  emit('update:modelValue', [...props.modelValue, ...missing]);
}

function selectNone() {
  emit(
    'update:modelValue',
    props.modelValue.filter((id) => !props.ids.includes(id))
  );
}
</script>

<template>
  <div class="actions selection-buttons">
    <button
      type="button"
      class="secondary"
      :data-test="`${name}-all`"
      :disabled="allSelected"
      @click="selectAll"
    >
      Select all
    </button>
    <button
      type="button"
      class="secondary"
      :data-test="`${name}-none`"
      :disabled="noneSelected"
      @click="selectNone"
    >
      Select none
    </button>
  </div>
</template>
