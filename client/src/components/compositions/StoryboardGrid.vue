<script setup>
// The storyboard itself: scenes across, elements down, and in each cell what
// that element does in that scene. Everything on it is edited in place —
// a scene's name and length in its heading, an element's name and kind in
// its row, a cell by pressing it — because a storyboard is a thing you
// scribble on, not a form you fill in.
//
// A cell that does not exist is an element that is not playing then, so the
// grid draws every (scene, element) pair whether or not the server holds a
// row for it: the empty ones are where the next press goes.
import { computed, ref } from 'vue';
import { api } from '../../api.js';
import { dialog } from '../../dialog.js';
import {
  CELL_ACTIONS,
  ELEMENT_KINDS,
  actionLabel,
  actionSymbol,
  formatDuration,
  kindColor,
  kindLabel,
  parseDuration,
} from '../../compositionVocabulary.js';

const props = defineProps({
  composition: { type: Object, required: true },
  compositionId: { type: String, required: true },
});
const emit = defineEmits(['reload']);

const base = computed(() => `/api/compositions/${props.compositionId}`);
const scenes = computed(() => props.composition.scenes || []);
const elements = computed(() => props.composition.elements || []);
const cellByPair = computed(() => {
  const map = new Map();
  for (const cell of props.composition.cells || []) map.set(`${cell.scene_id}:${cell.element_id}`, cell);
  return map;
});
const cellOf = (scene, element) => cellByPair.value.get(`${scene.id}:${element.id}`) ?? null;

// The whole piece's length, when its scenes are timed.
const totalDuration = computed(() =>
  scenes.value.reduce((sum, s) => sum + (Number(s.duration_seconds) || 0), 0)
);

const error = ref('');
const busy = ref(false);

// One write, then the record is read back: the grid is small, and reading
// it back is what keeps every cell showing what the server holds.
async function write(fn) {
  error.value = '';
  busy.value = true;
  try {
    await fn();
    emit('reload');
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}

// ---- scenes ----
const newSceneName = ref('');
const newSceneDuration = ref('');
const editingScene = ref(null);
const sceneDraft = ref({ name: '', duration: '', description: '' });

function durationOrError(text) {
  const seconds = parseDuration(text);
  if (Number.isNaN(seconds)) {
    error.value = 'A length is minutes:seconds ("1:30"), or seconds ("90").';
    return undefined;
  }
  return seconds;
}

async function addScene() {
  const duration = durationOrError(newSceneDuration.value);
  if (duration === undefined) return;
  const ok = await write(() =>
    api.post(`${base.value}/scenes`, { name: newSceneName.value, duration_seconds: duration })
  );
  if (ok) {
    newSceneName.value = '';
    newSceneDuration.value = '';
  }
}

function startScene(scene) {
  editingScene.value = scene.id;
  sceneDraft.value = {
    name: scene.name,
    duration: formatDuration(scene.duration_seconds),
    description: scene.description ?? '',
  };
}

async function saveScene(scene) {
  const duration = durationOrError(sceneDraft.value.duration);
  if (duration === undefined) return;
  const ok = await write(() =>
    api.put(`${base.value}/scenes/${scene.id}`, {
      name: sceneDraft.value.name,
      duration_seconds: duration,
      description: sceneDraft.value.description,
    })
  );
  if (ok) editingScene.value = null;
}

async function removeScene(scene) {
  const ok = await dialog.confirm({
    title: 'Delete scene',
    message: `Delete scene '${scene.name}'? What every element does in it is lost.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await write(() => api.delete(`${base.value}/scenes/${scene.id}`));
}

// Moving is the whole order re-sent: the server replaces every position at
// once, so two moves cannot interleave into an order nobody asked for.
async function moveScene(scene, delta) {
  const ids = scenes.value.map((s) => s.id);
  const index = ids.indexOf(scene.id);
  if (index + delta < 0 || index + delta >= ids.length) return;
  [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
  await write(() => api.put(`${base.value}/scenes/order`, { scene_ids: ids }));
}

// ---- elements ----
const newElementName = ref('');
const newElementKind = ref('voice');
const editingElement = ref(null);
const elementDraft = ref({ name: '', kind: 'voice', description: '' });

async function addElement() {
  const ok = await write(() =>
    api.post(`${base.value}/elements`, { name: newElementName.value, kind: newElementKind.value })
  );
  if (ok) newElementName.value = '';
}

function startElement(element) {
  editingElement.value = element.id;
  elementDraft.value = {
    name: element.name,
    kind: element.kind,
    description: element.description ?? '',
  };
}

async function saveElement(element) {
  const ok = await write(() =>
    api.put(`${base.value}/elements/${element.id}`, { ...elementDraft.value })
  );
  if (ok) editingElement.value = null;
}

async function removeElement(element) {
  const ok = await dialog.confirm({
    title: 'Delete element',
    message: `Delete '${element.name}'? Its cells, and every mapping of it onto a patch, are lost.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await write(() => api.delete(`${base.value}/elements/${element.id}`));
}

async function moveElement(element, delta) {
  const ids = elements.value.map((e) => e.id);
  const index = ids.indexOf(element.id);
  if (index + delta < 0 || index + delta >= ids.length) return;
  [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
  await write(() => api.put(`${base.value}/elements/order`, { element_ids: ids }));
}

// ---- cells ----
const editingCell = ref(null);
const cellAction = ref('hold');
const cellNote = ref('');

const isEditingCell = (scene, element) =>
  editingCell.value?.sceneId === scene.id && editingCell.value?.elementId === element.id;

function startCell(scene, element) {
  const cell = cellOf(scene, element);
  editingCell.value = { sceneId: scene.id, elementId: element.id };
  // A new cell starts as an entrance if the element was not playing in the
  // scene before, else as a hold: what the previous column says is the
  // likeliest answer.
  const previous = scenes.value[scenes.value.indexOf(scene) - 1];
  const before = previous ? cellOf(previous, element) : null;
  cellAction.value = cell?.action ?? (before && before.action !== 'exit' ? 'hold' : 'enter');
  cellNote.value = cell?.note ?? '';
  error.value = '';
}

async function saveCell(scene, element) {
  const ok = await write(() =>
    api.put(`${base.value}/scenes/${scene.id}/elements/${element.id}`, {
      action: cellAction.value,
      note: cellNote.value,
    })
  );
  if (ok) editingCell.value = null;
}

async function clearCell(scene, element) {
  const ok = await write(() => api.delete(`${base.value}/scenes/${scene.id}/elements/${element.id}`));
  if (ok) editingCell.value = null;
}
</script>

<template>
  <div class="panel" data-test="storyboard">
    <h2 class="actions">
      Storyboard
      <span v-if="totalDuration" class="muted" data-test="total-duration">
        {{ formatDuration(totalDuration) }} in all
      </span>
    </h2>
    <p v-if="error" class="error" data-test="storyboard-error">{{ error }}</p>
    <p v-if="!scenes.length && !elements.length" class="muted" data-test="empty-storyboard">
      Nothing here yet. Add the scenes of the piece in order, and the parts it is made of; then
      press a cell to say what each part does in each scene.
    </p>
    <div v-else class="table-wrap">
      <table class="storyboard" data-test="storyboard-grid">
        <thead>
          <tr>
            <th>Element</th>
            <th
              v-for="(scene, index) in scenes"
              :key="scene.id"
              class="scene-head"
              :data-test="`scene-head-${scene.id}`"
            >
              <form
                v-if="editingScene === scene.id"
                class="scene-edit"
                @submit.prevent="saveScene(scene)"
              >
                <input v-model="sceneDraft.name" data-test="scene-name-input" aria-label="Scene name" />
                <input
                  v-model="sceneDraft.duration"
                  placeholder="length, e.g. 1:30"
                  data-test="scene-duration-input"
                  aria-label="Scene length"
                />
                <textarea
                  v-model="sceneDraft.description"
                  rows="2"
                  placeholder="What happens"
                  data-test="scene-description-input"
                ></textarea>
                <div class="actions">
                  <button type="submit" data-test="scene-save">Save</button>
                  <button type="button" class="secondary" @click="editingScene = null">Cancel</button>
                </div>
              </form>
              <template v-else>
                <span class="scene-name">{{ scene.name }}</span>
                <span v-if="scene.duration_seconds !== null" class="muted scene-length">
                  {{ formatDuration(scene.duration_seconds) }}
                </span>
                <span v-if="scene.description" class="muted scene-caption">{{ scene.description }}</span>
                <div class="actions scene-actions">
                  <button
                    type="button"
                    class="secondary"
                    :disabled="index === 0 || busy"
                    title="Move earlier"
                    data-test="scene-left"
                    @click="moveScene(scene, -1)"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    :disabled="index === scenes.length - 1 || busy"
                    title="Move later"
                    data-test="scene-right"
                    @click="moveScene(scene, 1)"
                  >
                    →
                  </button>
                  <button type="button" class="secondary" data-test="scene-edit" @click="startScene(scene)">
                    Edit
                  </button>
                  <button type="button" class="danger" data-test="scene-delete" @click="removeScene(scene)">
                    ✕
                  </button>
                </div>
              </template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(element, index) in elements" :key="element.id" :data-test="`element-row-${element.id}`">
            <td data-label="Element" class="element-cell">
              <form
                v-if="editingElement === element.id"
                class="element-edit"
                @submit.prevent="saveElement(element)"
              >
                <input v-model="elementDraft.name" data-test="element-name-input" aria-label="Element name" />
                <select v-model="elementDraft.kind" data-test="element-kind-input" aria-label="Element kind">
                  <option v-for="kind in ELEMENT_KINDS" :key="kind.key" :value="kind.key">
                    {{ kind.label }}
                  </option>
                </select>
                <textarea
                  v-model="elementDraft.description"
                  rows="2"
                  placeholder="What it is"
                  data-test="element-description-input"
                ></textarea>
                <div class="actions">
                  <button type="submit" data-test="element-save">Save</button>
                  <button type="button" class="secondary" @click="editingElement = null">Cancel</button>
                </div>
              </form>
              <template v-else>
                <span class="element-name">
                  <span
                    class="type-swatch"
                    :style="{ background: kindColor(element.kind) }"
                    :title="kindLabel(element.kind)"
                  ></span>
                  {{ element.name }}
                </span>
                <span class="muted element-kind">{{ kindLabel(element.kind) }}</span>
                <span v-if="element.description" class="muted element-caption">{{ element.description }}</span>
                <div class="actions element-actions">
                  <button
                    type="button"
                    class="secondary"
                    :disabled="index === 0 || busy"
                    title="Move up"
                    data-test="element-up"
                    @click="moveElement(element, -1)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    :disabled="index === elements.length - 1 || busy"
                    title="Move down"
                    data-test="element-down"
                    @click="moveElement(element, 1)"
                  >
                    ↓
                  </button>
                  <button type="button" class="secondary" data-test="element-edit" @click="startElement(element)">
                    Edit
                  </button>
                  <button type="button" class="danger" data-test="element-delete" @click="removeElement(element)">
                    ✕
                  </button>
                </div>
              </template>
            </td>
            <td
              v-for="scene in scenes"
              :key="scene.id"
              :data-label="scene.name"
              class="cell"
              :data-test="`cell-${scene.id}-${element.id}`"
            >
              <form
                v-if="isEditingCell(scene, element)"
                class="cell-edit"
                @submit.prevent="saveCell(scene, element)"
              >
                <select v-model="cellAction" data-test="cell-action" aria-label="What it does">
                  <option v-for="action in CELL_ACTIONS" :key="action.key" :value="action.key">
                    {{ action.symbol }} {{ action.label }}
                  </option>
                </select>
                <textarea
                  v-model="cellNote"
                  rows="2"
                  placeholder="How — 'open the cutoff over the whole scene'"
                  data-test="cell-note"
                ></textarea>
                <div class="actions">
                  <button type="submit" :disabled="busy" data-test="cell-save">Save</button>
                  <button
                    v-if="cellOf(scene, element)"
                    type="button"
                    class="secondary"
                    :disabled="busy"
                    data-test="cell-clear"
                    @click="clearCell(scene, element)"
                  >
                    Not playing
                  </button>
                  <button type="button" class="secondary" @click="editingCell = null">Cancel</button>
                </div>
              </form>
              <button
                v-else
                type="button"
                class="cell-button"
                :class="cellOf(scene, element) ? `is-${cellOf(scene, element).action}` : 'is-empty'"
                :title="
                  cellOf(scene, element)
                    ? `${element.name} ${actionLabel(cellOf(scene, element).action).toLowerCase()} in ${scene.name}`
                    : `${element.name} is not playing in ${scene.name}`
                "
                data-test="cell-button"
                @click="startCell(scene, element)"
              >
                <template v-if="cellOf(scene, element)">
                  <span class="cell-symbol">{{ actionSymbol(cellOf(scene, element).action) }}</span>
                  <span class="cell-label">{{ actionLabel(cellOf(scene, element).action) }}</span>
                  <span v-if="cellOf(scene, element).note" class="cell-note">
                    {{ cellOf(scene, element).note }}
                  </span>
                </template>
                <span v-else class="cell-empty">
                  <span class="cell-empty-dot">·</span>
                  <span class="cell-empty-text">not playing</span>
                </span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="adders">
      <form class="adder" data-test="add-element-form" @submit.prevent="addElement">
        <label for="new-element-name">Add a part</label>
        <input
          id="new-element-name"
          v-model="newElementName"
          placeholder="Bass, kick, filter sweep…"
          data-test="new-element-name"
        />
        <select v-model="newElementKind" data-test="new-element-kind" aria-label="What kind of part">
          <option v-for="kind in ELEMENT_KINDS" :key="kind.key" :value="kind.key">{{ kind.label }}</option>
        </select>
        <button type="submit" :disabled="busy || !newElementName.trim()" data-test="add-element">
          Add part
        </button>
      </form>
      <form class="adder" data-test="add-scene-form" @submit.prevent="addScene">
        <label for="new-scene-name">Add a scene</label>
        <input
          id="new-scene-name"
          v-model="newSceneName"
          placeholder="Intro, build, drop…"
          data-test="new-scene-name"
        />
        <input
          v-model="newSceneDuration"
          placeholder="length, e.g. 1:30"
          data-test="new-scene-duration"
          aria-label="Scene length"
        />
        <button type="submit" :disabled="busy || !newSceneName.trim()" data-test="add-scene">
          Add scene
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.storyboard th,
.storyboard td {
  vertical-align: top;
}
.scene-head {
  min-width: 11rem;
}
.scene-name {
  display: block;
  font-weight: 600;
}
.scene-length,
.scene-caption,
.element-kind,
.element-caption {
  display: block;
  font-size: 0.8rem;
  font-weight: 400;
}
/* A heading is set in small capitals; a scene's caption is a sentence. */
.scene-caption {
  text-transform: none;
  letter-spacing: normal;
  max-width: 16rem;
  white-space: normal;
}
/* On a desk an empty cell is a dot in a row of cells; on a phone it stands
   alone under the scene's name and has to say what it is. */
.cell-empty-text {
  display: none;
}
@media (max-width: 768px) {
  .cell-empty-dot {
    display: none;
  }
  .cell-empty-text {
    display: inline;
  }
}
.scene-actions,
.element-actions {
  margin-top: 0.3rem;
}
.scene-actions button,
.element-actions button {
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
}
.element-cell {
  min-width: 12rem;
}
.element-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}
.scene-edit,
.element-edit,
.cell-edit {
  display: grid;
  gap: 0.3rem;
  min-width: 11rem;
}

/* A cell is a button the size of the cell: the whole thing is the press. */
.cell {
  padding: 0.2rem;
}
.cell-button {
  display: block;
  width: 100%;
  min-height: 3.2rem;
  text-align: left;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.cell-button:hover {
  border-color: var(--border-strong);
}
.cell-button.is-empty {
  color: var(--muted);
  text-align: center;
}
.cell-button.is-enter {
  border-style: solid;
  border-color: #22c55e;
}
.cell-button.is-hold {
  border-style: solid;
  border-color: var(--border-strong);
}
.cell-button.is-change {
  border-style: solid;
  border-color: #f59e0b;
}
.cell-button.is-exit {
  border-style: solid;
  border-color: #ef4444;
}
.cell-symbol {
  margin-right: 0.35rem;
}
.cell-label {
  font-size: 0.8rem;
}
.cell-note {
  display: block;
  font-size: 0.8rem;
  color: var(--muted);
  white-space: pre-wrap;
}

.adders {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin-top: 1rem;
}
.adder {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.adder label {
  font-weight: 600;
}
</style>
