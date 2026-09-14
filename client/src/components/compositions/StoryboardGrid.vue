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
//
// The page calls an element a PART. The parts are defined once, for the
// whole piece, and a scene contains whichever of them have a cell in its
// column — so a part is put into a scene from either side: by pressing its
// empty cell, or from the scene's own heading, which counts the parts in it
// and offers the ones that are not.
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

// A part that plays in NO scene is a part that has only been defined so far.
// A piece may have a dozen of those and a two-part intro, so they can be
// hidden while the grid is worked on; the adder still puts a new one in.
const hideUnused = ref(false);
const playsSomewhere = (element) => scenes.value.some((scene) => cellOf(scene, element));
const unusedCount = computed(() => elements.value.filter((e) => !playsSomewhere(e)).length);
const visibleElements = computed(() =>
  hideUnused.value ? elements.value.filter(playsSomewhere) : elements.value
);

// What each scene contains: the parts with a cell in its column, and the
// ones its heading may still add.
const partsIn = (scene) => elements.value.filter((element) => cellOf(scene, element));
const partsNotIn = (scene) => elements.value.filter((element) => !cellOf(scene, element));

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
    message: `Delete scene '${scene.name}'? What every part does in it is lost.`,
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
    title: 'Delete part',
    message: `Delete '${element.name}'? Its cells, and every mapping of it onto a patch, are lost.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await write(() => api.delete(`${base.value}/elements/${element.id}`));
}

// Up and down are over the parts ON SCREEN: with the unused ones hidden,
// moving a part up puts it before the visible part above it, not before a
// hidden one nobody can see it pass.
const isFirstShown = (element) => visibleElements.value[0]?.id === element.id;
const isLastShown = (element) => visibleElements.value.at(-1)?.id === element.id;

async function moveElement(element, delta) {
  const shown = visibleElements.value;
  const neighbour = shown[shown.indexOf(element) + delta];
  if (!neighbour) return;
  const ids = elements.value.map((e) => e.id).filter((id) => id !== element.id);
  ids.splice(ids.indexOf(neighbour.id) + (delta > 0 ? 1 : 0), 0, element.id);
  await write(() => api.put(`${base.value}/elements/order`, { element_ids: ids }));
}

// ---- cells ----
const editingCell = ref(null);
const cellAction = ref('hold');
const cellNote = ref('');

const isEditingCell = (scene, element) =>
  editingCell.value?.sceneId === scene.id && editingCell.value?.elementId === element.id;

// A new cell starts as an entrance if the element was not playing in the
// scene before, else as a hold: what the previous column says is the
// likeliest answer.
function firstAction(scene, element) {
  const previous = scenes.value[scenes.value.indexOf(scene) - 1];
  const before = previous ? cellOf(previous, element) : null;
  return before && before.action !== 'exit' ? 'hold' : 'enter';
}

function startCell(scene, element) {
  const cell = cellOf(scene, element);
  editingCell.value = { sceneId: scene.id, elementId: element.id };
  cellAction.value = cell?.action ?? firstAction(scene, element);
  cellNote.value = cell?.note ?? '';
  error.value = '';
}

// The scene's own way in: picking a part in its heading writes the same
// cell the press would, with the same first guess at what the part does,
// and the note is a second press away.
const pickedPart = ref({});

async function addPartToScene(scene) {
  const elementId = Number(pickedPart.value[scene.id]);
  const element = elements.value.find((e) => e.id === elementId);
  pickedPart.value = { ...pickedPart.value, [scene.id]: '' };
  if (!element) return;
  await write(() =>
    api.put(`${base.value}/scenes/${scene.id}/elements/${element.id}`, {
      action: firstAction(scene, element),
      note: '',
    })
  );
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
            <th>Part</th>
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
                <span v-if="elements.length" class="muted scene-parts" :data-test="`scene-parts-${scene.id}`">
                  {{ partsIn(scene).length }} of {{ elements.length }} parts
                </span>
                <select
                  v-if="partsNotIn(scene).length"
                  v-model="pickedPart[scene.id]"
                  class="scene-add-part"
                  :disabled="busy"
                  :aria-label="`Add a part to ${scene.name}`"
                  :data-test="`scene-add-part-${scene.id}`"
                  @change="addPartToScene(scene)"
                >
                  <option value="">Add a part…</option>
                  <option v-for="element in partsNotIn(scene)" :key="element.id" :value="element.id">
                    {{ element.name }}
                  </option>
                </select>
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
          <tr v-for="element in visibleElements" :key="element.id" :data-test="`element-row-${element.id}`">
            <td data-label="Part" class="element-cell">
              <form
                v-if="editingElement === element.id"
                class="element-edit"
                @submit.prevent="saveElement(element)"
              >
                <input v-model="elementDraft.name" data-test="element-name-input" aria-label="Part name" />
                <select v-model="elementDraft.kind" data-test="element-kind-input" aria-label="Part kind">
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
                    :disabled="isFirstShown(element) || busy"
                    title="Move up"
                    data-test="element-up"
                    @click="moveElement(element, -1)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    :disabled="isLastShown(element) || busy"
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
                    : `${element.name} is not playing in ${scene.name} — press to add it`
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
                  <span class="cell-empty-add">+ add</span>
                </span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <label v-if="unusedCount" class="muted unused-filter" data-test="unused-filter">
      <input v-model="hideUnused" type="checkbox" data-test="hide-unused" />
      Hide the {{ unusedCount }} {{ unusedCount === 1 ? 'part' : 'parts' }} not in any scene
    </label>

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
/* On a desk an empty cell is a dot in a row of cells, and under the pointer
   it says what a press there does; on a phone it stands alone under the
   scene's name and has to say what it is. */
.cell-empty-text,
.cell-empty-add {
  display: none;
}
.cell-button.is-empty:hover .cell-empty-dot,
.cell-button.is-empty:focus-visible .cell-empty-dot {
  display: none;
}
.cell-button.is-empty:hover .cell-empty-add,
.cell-button.is-empty:focus-visible .cell-empty-add {
  display: inline;
}
@media (max-width: 768px) {
  .cell-button.is-empty .cell-empty-dot,
  .cell-button.is-empty .cell-empty-add,
  .cell-button.is-empty:hover .cell-empty-add,
  .cell-button.is-empty:focus-visible .cell-empty-add {
    display: none;
  }
  .cell-empty-text {
    display: inline;
  }
}
.scene-parts {
  display: block;
  font-size: 0.8rem;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}
.scene-add-part {
  display: block;
  margin-top: 0.3rem;
  font-size: 0.8rem;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  max-width: 11rem;
}
.unused-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.75rem;
  font-size: 0.85rem;
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
