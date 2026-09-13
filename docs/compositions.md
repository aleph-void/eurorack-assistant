# Compositions: storyboarding a piece, and mapping it onto a patch

Everything else in the app is about the hardware and a moment of it. A module
is what its manual says it is. A patch is the cables and control settings of
one arrangement of the case. Neither says what the music DOES over the next
eight minutes: where the bass comes in, when the filter opens, which scene the
drums drop out of. A performer scribbles that on a sheet of paper and props it
against the case. A composition is that sheet of paper, and the mapping is
what turns it into "this knob, that cable" for the patch in front of you.

- [The two ideas](#the-two-ideas)
- [Data model](#data-model)
- [API](#api)
- [The pages](#the-pages)
- [Decisions worth knowing](#decisions-worth-knowing)
- [What this could grow into](#what-this-could-grow-into)
- [The files](#the-files)

---

## The two ideas

**A storyboard is a grid.** The SCENES of the piece run across the top in the
order they are played (intro, build, drop, outro), each with a caption saying
what happens in it and, when the piece is timed, how long it runs. The
ELEMENTS run down the side: the parts the piece is made of, the bass, the
kick, the wash, the filter you ride. Each is one of a few kinds (a voice, a
rhythm, a modulation, an effect, a texture, a control, or other), which is a
colour on the page and nothing more. In each CELL is what that element does in
that scene, one of four things: it enters, it holds, it changes, or it exits,
with a free-text note saying how ("open the cutoff over the whole scene"). A
cell that does not exist is an element that is not playing then.

The storyboard names no hardware, on purpose. It is written before the patch
exists and it survives the case being rebuilt. "The bass" is a musical idea;
which oscillator plays it is a fact about one patch.

**A mapping binds the storyboard to a patch.** A composition is mapped onto a
patch, and that pair is a record of its own, because a piece can be played on
more than one patch (the small case, the whole studio, last year's version of
either) and "the way I play it on the small case" has notes of its own. Under
the pair, each element is bound to what realises it in that patch. One binding
is one of four shapes:

| shape | what it names | example |
| --- | --- | --- |
| a module instance | `patch_module_id` | the bass IS Maths #1 |
| one control or jack of an instance | `patch_module_id` + `component_id` | the filter you ride IS Ripples' cutoff |
| a bus | `group_id` | the rhythm section IS the Drums group |
| a cable | `cable_id` | the sidechain IS this cable |

One element may need several bindings: a voice is an oscillator, a filter and
the envelope that opens it. The performance sheet is the storyboard read
against the mapping: the same grid, each part's row headed by what plays it
here.

## Data model

Migration `046_compositions.js`. Six tables:

```
compositions                one row per piece, per user
  user_id  FK users         name is unique per user (like patches)
  name, description, tempo_bpm

composition_scenes          the columns, in `position` order
  composition_id  FK cascade
  name, description, duration_seconds (nullable), position

composition_elements        the rows, in `position` order
  composition_id  FK cascade
  name, kind, description, position

composition_scene_elements  the cells; unique (scene_id, element_id)
  scene_id    FK cascade
  element_id  FK cascade
  action      enter | hold | change | exit
  note

composition_patches         one piece mapped onto one patch; unique pair
  composition_id  FK cascade
  patch_id        FK patches cascade
  notes

composition_mappings        one element bound to one thing in that patch
  composition_patch_id  FK cascade
  element_id            FK cascade
  patch_module_id, component_id, group_id, cable_id   (soft)
  target_label          what it was called when bound
  note, position
  CHECK exactly one of patch_module_id / group_id / cable_id is set
  CHECK component_id is only set alongside patch_module_id
```

Two kinds of reference, deliberately. The composition and the patch are HARD
references: a mapping onto a deleted patch is nothing at all, and deleting a
composition takes its whole storyboard and every mapping with it. The targets
inside the patch are SOFT references with the target's name snapshotted beside
them, the way a patch keeps its own module and component names: an instance
removed from the patch, a cable unplugged, a bus deleted or a module
re-analysed under new component ids leaves a mapping that still reads what it
pointed at, marked `live: false`, and asks to be re-bound. The alternative, a
cascading foreign key, would make a binding vanish silently the moment someone
tidied the patch.

The vocabulary (`ELEMENT_KINDS`, `CELL_ACTIONS`) lives in
`server/src/services/compositions.js` and is mirrored in
`client/src/compositionVocabulary.js`; the server is what validates.

## API

All under `/api/compositions`, all behind the session, all private to the
owner. Every write returns the row it made; every page re-reads the record
after a write.

```
GET    /                              one page, { compositions, total, has_more, next_before }
GET    /?patch_id=12                  the compositions mapped onto that patch (+ realization_id,
                                      mapped_element_count, notes)
POST   /                              { name, description?, tempo_bpm? }         201 | 409 name taken
GET    /:id                           the storyboard whole: scenes, elements, cells, patches
PUT    /:id                           { name?, description?, tempo_bpm? }
DELETE /:id

POST   /:id/scenes                    { name, description?, duration_seconds?, position? }
PUT    /:id/scenes/order              { scene_ids: [every scene, once, in order] }
PUT    /:id/scenes/:sceneId           { name?, description?, duration_seconds?, position? }
DELETE /:id/scenes/:sceneId           its cells go with it

POST   /:id/elements                  { name, kind?, description?, position? }
PUT    /:id/elements/order            { element_ids: [...] }
PUT    /:id/elements/:elementId
DELETE /:id/elements/:elementId       its cells and its mappings go with it

PUT    /:id/scenes/:s/elements/:e     { action, note? }   upsert the cell (201 new, 200 replaced)
DELETE /:id/scenes/:s/elements/:e     the element is not playing in that scene

POST   /:id/patches                   { patch_id, notes? }   201 | 409 already mapped | 404 not your patch
GET    /:id/patches/:patchId          the mapping whole: elements, bindings with `live`
PUT    /:id/patches/:patchId          { notes }
DELETE /:id/patches/:patchId          every binding goes; composition and patch stay

POST   /:id/patches/:patchId/mappings { element_id, patch_module_id? (+ component_id?) | group_id | cable_id, note? }
PUT    /:id/patches/:patchId/mappings/:mappingId   { note?, position? }   a target is not edited: remove and re-bind
DELETE /:id/patches/:patchId/mappings/:mappingId
```

The list is paged by id the way the patch list is. Reordering replaces every
position at once under the composition's row lock, so two reorders cannot
interleave into an order nobody sent; the list must name every row exactly
once. A binding request that names nothing, two things, a component without
its instance, or anything not in the patch is refused with a sentence before
the CHECK would refuse it with a constraint name.

## The pages

- `/compositions`: the list, with how many scenes, parts and patches each has,
  and the form that makes one. A new composition opens on its storyboard.
- `/compositions/:id`: the STORYBOARD. Everything is edited in place. A
  scene's name, length and caption in its column heading, with arrows to move
  it earlier or later. An element's name, kind and description in its row,
  with arrows to move it up or down. A cell by pressing it: pick what the part
  does, say how, save, or say it is not playing. A new cell opens as an
  entrance when the part was not playing in the previous scene and as a hold
  when it was. A scene's length is typed as a person would ("1:30", "90",
  "2m") and the whole piece's length is added up in the heading. Under the
  grid, "Patches that perform it": each mapping with its coverage ("3 of 5
  parts mapped"), and the picker that maps the piece onto another patch, which
  takes you to the mapping page.
- `/compositions/:id/patches/:patchId`: the MAPPING. One row per part, listing
  what plays it, with a "Bind…" that opens a picker: the shape (an instance,
  one control or jack, a bus, a cable), then the thing, offered from the patch
  payload and named the way the patch's own pages name it. A binding whose
  target has left the patch is struck through and says so. Then the notes on
  this way of playing it, then the PERFORMANCE SHEET: the storyboard with each
  part headed by what plays it here, the thing to put on the music stand.
- `/patches/:id/compositions`: the same pair from the patch's side, in the
  patch's nav drawer under "Your work": the compositions performed on this
  patch and the picker that maps another onto it.

The grid follows the house rule for tables on a phone: each part becomes a
card with one line per scene, labelled with the scene's name.

## Decisions worth knowing

- **The element is the unit of mapping, not the cell.** "The bass" is bound to
  Maths #1 once per patch, and every scene's cell about the bass inherits it.
  Binding per cell would repeat the same fact across every column and make
  moving the bass to another oscillator a dozen edits.
- **The storyboard is patch-independent.** It is the thing you can write on
  the train. A composition with no mappings is a complete record.
- **The pair is a record.** `composition_patches` exists rather than putting
  `patch_id` on each mapping, so the pair can carry notes, be listed from both
  sides with a coverage count, and be unmapped in one delete.
- **Targets are soft, with a label.** See the data model. `live` is computed
  at read time by looking the target up in the patch's current rows; nothing
  is written when a patch changes.
- **A composition name is one per account**, the rule patches follow, because
  the list and the pickers say which piece they mean by name.
- **Nothing here reaches the LLM yet.** A composition is not attached to a
  question, and no job reads one.

## What this could grow into

- **Per-scene settings.** A `change` cell says "open the cutoff" in words. The
  natural next fact is the value: a `composition_scene_settings` row per (cell,
  binding) with a `value`, the shape `patch_settings` already has, so a scene
  could be recalled as a set of knob positions and diffed against the last.
- **Asking about a composition.** Attaching a composition (storyboard + the
  mapping onto the attached patch) to a question, so "how do I make scene 3
  land harder?" is answered against the cables and the storyboard together.
- **Export and import** as a JSON document beside the patch one, resolved by
  element name and by the patch's own names on import.
- **A timeline view** of the storyboard drawn to scale from `duration_seconds`,
  when the piece is timed.
- **Cloning** a composition, and cloning a mapping onto a rebuilt patch by
  matching module and component names, the way a patch import resolves names.

## The files

- `server/migrations/046_compositions.js`: the schema, with the reasoning.
- `server/src/db/models/compositions.js`: the models; associations in
  `db/models/associations.js`.
- `server/src/services/compositions.js`: the vocabulary, the serializers, the
  loaders (`loadCompositionDetail`, `loadRealization`) and
  `resolveMappingTarget`, which checks a binding against the patch and names
  it.
- `server/src/routes/compositions/`: `core.js` (the record), `storyboard.js`
  (scenes, elements, cells, ordering), `mappings.js` (the pair and its
  bindings), `helpers.js` (ownership middleware).
- `client/src/compositionVocabulary.js`: the kinds, the actions, their words
  and colours, and the duration parsing.
- `client/src/components/compositions/`: `useCompositionRecord.js`,
  `CompositionHeader.vue`, `StoryboardGrid.vue`, `MappedPatches.vue`,
  `MappingTable.vue`, `PerformanceSheet.vue`.
- `client/src/views/`: `CompositionsView.vue`, `CompositionStoryboardView.vue`,
  `CompositionMappingView.vue`, `PatchCompositionsView.vue`.
- Tests: `server/tests/compositions.test.js`;
  `client/tests/views/compositions.test.js`, `compositionStoryboard.test.js`,
  `compositionMapping.test.js`, `patchCompositions.test.js`, with payloads in
  `client/tests/compositionFixtures.js`.
