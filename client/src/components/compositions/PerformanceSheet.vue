<script setup>
// The storyboard read against one patch: the same grid, with each part's row
// headed by what plays it here. This is the sheet on the music stand — "in
// the build, the bass changes: open Ripples' cutoff over the whole scene" —
// so it is read-only, and it is drawn from the same two payloads the editors
// above it are.
import { computed } from 'vue';
import {
  actionLabel,
  actionSymbol,
  formatDuration,
  kindColor,
} from '../../compositionVocabulary.js';

const props = defineProps({
  composition: { type: Object, required: true },
  mappings: { type: Array, default: () => [] },
});

const scenes = computed(() => props.composition.scenes || []);
const elements = computed(() => props.composition.elements || []);
const cellByPair = computed(() => {
  const map = new Map();
  for (const cell of props.composition.cells || []) map.set(`${cell.scene_id}:${cell.element_id}`, cell);
  return map;
});
const cellOf = (scene, element) => cellByPair.value.get(`${scene.id}:${element.id}`) ?? null;
const targetsOf = (element) => props.mappings.filter((m) => m.element_id === element.id && m.live);
</script>

<template>
  <details class="panel" open data-test="performance-sheet">
    <summary><h2>Performance sheet</h2></summary>
    <div class="panel-body">
      <p v-if="!scenes.length || !elements.length" class="muted">
        The sheet is the storyboard read against this patch; it needs at least one scene and one
        part.
      </p>
      <div v-else class="table-wrap">
        <table data-test="sheet">
          <thead>
            <tr>
              <th>Part</th>
              <th v-for="scene in scenes" :key="scene.id">
                {{ scene.name }}
                <span v-if="scene.duration_seconds !== null" class="muted length">
                  {{ formatDuration(scene.duration_seconds) }}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="element in elements" :key="element.id" :data-test="`sheet-row-${element.id}`">
              <td data-label="Part">
                <span class="part">
                  <span class="type-swatch" :style="{ background: kindColor(element.kind) }"></span>
                  {{ element.name }}
                </span>
                <ul v-if="targetsOf(element).length" class="targets">
                  <li v-for="m in targetsOf(element)" :key="m.id">{{ m.target_label }}</li>
                </ul>
                <span v-else class="muted unmapped">not mapped</span>
              </td>
              <td v-for="scene in scenes" :key="scene.id" :data-label="scene.name">
                <template v-if="cellOf(scene, element)">
                  <span :class="`is-${cellOf(scene, element).action}`">
                    {{ actionSymbol(cellOf(scene, element).action) }}
                    {{ actionLabel(cellOf(scene, element).action) }}
                  </span>
                  <span v-if="cellOf(scene, element).note" class="muted note">
                    {{ cellOf(scene, element).note }}
                  </span>
                </template>
                <span v-else class="muted">·</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </details>
</template>

<style scoped>
.part {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}
.targets {
  margin: 0.2rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.8rem;
}
.unmapped,
.length {
  display: block;
  font-size: 0.8rem;
  font-weight: 400;
}
.note {
  display: block;
  font-size: 0.8rem;
  white-space: pre-wrap;
}
.is-enter {
  color: #22c55e;
}
.is-change {
  color: #f59e0b;
}
.is-exit {
  color: #ef4444;
}
</style>
