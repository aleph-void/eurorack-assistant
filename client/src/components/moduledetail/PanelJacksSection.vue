<script setup>
// The front plate, with the jacks on it listed beside it.
//
// A marker is put right by looking at the photograph and dragging it onto the
// hardware it names, so the list of what could be dragged belongs on the same
// screen as the picture — not on a page you have to go to and come back from.
// Every row here is a toggle: pick a jack and the plate shows that marker
// alone, pick it again (or Done) and the whole panel comes back. A marker on
// the plate is the same toggle from the other side.
//
// Drawn on the module's own page and on each of the jack pages, over whatever
// kinds of jack that page is about.

import { computed } from 'vue';
import ModulePanel from '../ModulePanel.vue';
import { componentColor, typeLabel } from '../../componentTypes.js';

const props = defineProps({
  module: { type: Object, required: true },
  // The arranging mode itself (moduledetail/useArranging.js). It is made by
  // the PAGE rather than here, because putting a marker right writes the
  // panel back into the record and the page is what holds that. Passing it
  // whole is also what lets the plate and the rows be one mode: a page that
  // draws this block twice would otherwise have two.
  arranging: { type: Object, required: true },
  // The jack types this block is about, in the order they are listed.
  kinds: {
    type: Array,
    default: () => ['input_jack', 'output_jack', 'bidirectional_jack'],
  },
});

// Destructured once, at setup: `arranging` is made once by the page and never
// replaced, and refs pulled out here are unwrapped in the template the way
// the page's own would be.
const {
  arrangedComponentId,
  arrangedComponent,
  arrange,
  stopArranging,
  arrangeError,
  movePanelMarker,
  panelError,
  panelStatus,
} = props.arranging;

const jacks = computed(() => {
  const rows = (props.module?.components || []).filter((c) => props.kinds.includes(c.type));
  // In the order the page names its kinds, and by name inside each — a
  // panel's jacks are named, not numbered, and analysis order is no order.
  return [...rows].sort(
    (a, b) =>
      props.kinds.indexOf(a.type) - props.kinds.indexOf(b.type) ||
      String(a.name).localeCompare(String(b.name))
  );
});

// Which jacks the picture has nowhere to put. Said out loud rather than left
// as a row that looks like the others: arranging one of these starts by
// giving it a marker in the middle of the plate.
const placedIds = computed(
  () => new Set((props.module?.panel?.components || []).map((p) => p.component_id))
);
const isPlaced = (jack) => placedIds.value.has(jack.id);

// A marker clicked on the plate arranges the component behind it, which is
// the same toggle the row beside it is.
function arrangeFromMarker({ component_id: componentId }) {
  const jack = (props.module?.components || []).find((c) => c.id === componentId);
  if (jack) arrange(jack);
}
</script>

<template>
  <div class="panel-jacks">
    <div class="panel-jacks-plate">
      <ModulePanel
        v-if="module.panel"
        :panel="module.panel"
        :only-component-id="arrangedComponentId"
        editable
        @move="movePanelMarker"
        @select="arrangeFromMarker"
      />
      <p v-else class="muted" data-test="panel-jacks-no-panel">
        No panel picture yet — there is nothing to arrange a marker on until the app finds one or
        you supply one.
      </p>
      <p v-if="arrangedComponent" class="panel-arrangement-filter" data-test="panel-arrangement-filter">
        <span>
          Arranging only <strong>{{ arrangedComponent.name }}</strong> — drag the marker onto the
          hardware it names.
        </span>
        <button
          type="button"
          class="secondary"
          data-test="panel-disable-arranging"
          @click="stopArranging"
        >
          Done
        </button>
      </p>
      <p v-if="panelStatus" class="muted" data-test="panel-status">{{ panelStatus }}</p>
      <p v-if="panelError" class="error" data-test="panel-error">{{ panelError }}</p>
      <p v-if="arrangeError" class="error" data-test="arrange-error">{{ arrangeError }}</p>
    </div>

    <div class="panel-jacks-list">
      <p v-if="jacks.length === 0" class="muted" data-test="panel-jacks-empty">
        None of these on this module.
      </p>
      <ul v-else class="jack-rows" data-test="panel-jacks">
        <li v-for="jack in jacks" :key="jack.id" :data-test="`panel-jack-${jack.id}`">
          <span class="jack-swatch" :style="{ background: componentColor(jack.type) }"></span>
          <span class="jack-name">
            {{ jack.name }}
            <em class="muted">{{ typeLabel(jack.type) }}</em>
            <em v-if="!isPlaced(jack)" class="muted" :data-test="`panel-jack-unplaced-${jack.id}`">
              · not on the picture yet
            </em>
          </span>
          <button
            type="button"
            class="secondary"
            :class="{ selected: arrangedComponentId === jack.id }"
            :disabled="!module.panel"
            :title="
              module.panel
                ? 'Show only this marker on the front plate and drag it into place'
                : 'There is no panel picture to arrange this marker on yet'
            "
            :data-test="`arrange-component-${jack.id}`"
            @click="arrange(jack)"
          >
            {{ arrangedComponentId === jack.id ? 'Arranging' : 'Arrange' }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
