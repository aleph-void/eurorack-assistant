import { Router } from 'express';
import {
  CELL_ACTIONS,
  ELEMENT_KINDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_DURATION_SECONDS,
  MAX_ELEMENTS,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SCENES,
  cellJson,
  elementJson,
  sceneJson,
  text,
} from '../../services/compositions.js';
import { requireOwnedComposition, wholeNumber } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// The storyboard: its scenes (the columns), its elements (the rows) and the
// cells that say what each element does in each scene.
export function compositionStoryboardRoutes(db) {
  const { CompositionScene, CompositionElement, CompositionSceneElement, Composition } = db.models;
  const router = Router();
  const owned = requireOwnedComposition(db);

  // A duration in seconds, or null for "as long as it takes".
  const readDuration = (value) => {
    if (value === undefined) return { skip: true };
    if (value === null || value === '') return { duration: null };
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_DURATION_SECONDS) {
      return { error: `duration_seconds must be between 0 and ${MAX_DURATION_SECONDS}` };
    }
    return { duration: n };
  };

  // Where a new row goes: at the end unless the request says otherwise. The
  // order is the user's, so a scene added today does not land before the
  // intro.
  const nextPosition = async (Model, compositionId) => {
    const last = await Model.findOne({
      where: { composition_id: compositionId },
      order: [['position', 'DESC']],
    });
    return (last?.position ?? -1) + 1;
  };

  // Reordering is a REPLACEMENT of every position at once, under the
  // composition's row lock: two reorders racing would otherwise interleave
  // their writes and leave an order neither of them sent. The list must name
  // every row exactly once, so a row can never be lost off the end of it.
  const reorder = async (Model, composition, ids, what) => {
    if (!Array.isArray(ids) || ids.some((id) => wholeNumber(id) === null)) {
      return { error: `${what}_ids must be a list of ids` };
    }
    const rows = await Model.findAll({ where: { composition_id: composition.id } });
    const wanted = ids.map(Number);
    const have = new Set(rows.map((r) => r.id));
    if (wanted.length !== have.size || new Set(wanted).size !== wanted.length ||
        wanted.some((id) => !have.has(id))) {
      return { error: `${what}_ids must name every ${what} of the composition exactly once` };
    }
    await db.sequelize.transaction(async (transaction) => {
      await Composition.findOne({
        where: { id: composition.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const [position, id] of wanted.entries()) {
        await Model.update({ position }, { where: { id }, transaction });
      }
    });
    return {};
  };

  // ---- scenes ----

  // Body: { name, description?, duration_seconds?, position? }
  router.post('/:id/scenes', owned, asyncHandler(async (req, res) => {
    const composition = req.composition;
    const name = text(req.body?.name, MAX_NAME_LENGTH);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const duration = readDuration(req.body?.duration_seconds);
    if (duration.error) return res.status(400).json({ error: duration.error });
    const count = await CompositionScene.count({ where: { composition_id: composition.id } });
    if (count >= MAX_SCENES) {
      return res.status(400).json({ error: `a storyboard holds at most ${MAX_SCENES} scenes` });
    }
    const scene = await CompositionScene.create({
      composition_id: composition.id,
      name,
      description: text(req.body?.description, MAX_DESCRIPTION_LENGTH),
      duration_seconds: duration.skip ? null : duration.duration,
      position: wholeNumber(req.body?.position) ?? (await nextPosition(CompositionScene, composition.id)),
    });
    res.status(201).json(sceneJson(scene));
  }));

  // Body: { scene_ids: [...] } — every scene of the composition, in the
  // order they should play. Declared before /:sceneId so 'order' is not
  // read as one.
  router.put('/:id/scenes/order', owned, asyncHandler(async (req, res) => {
    const { error } = await reorder(CompositionScene, req.composition, req.body?.scene_ids, 'scene');
    if (error) return res.status(400).json({ error });
    const scenes = await CompositionScene.findAll({
      where: { composition_id: req.composition.id },
      order: [['position', 'ASC'], ['id', 'ASC']],
    });
    res.json(scenes.map(sceneJson));
  }));

  const ownScene = (composition, id) =>
    CompositionScene.findOne({ where: { id: Number(id) || 0, composition_id: composition.id } });

  // Body: { name?, description?, duration_seconds?, position? }
  router.put('/:id/scenes/:sceneId', owned, asyncHandler(async (req, res) => {
    const scene = await ownScene(req.composition, req.params.sceneId);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name, MAX_NAME_LENGTH);
      if (!name) return res.status(400).json({ error: 'name is required' });
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = text(req.body.description, MAX_DESCRIPTION_LENGTH);
    }
    const duration = readDuration(req.body?.duration_seconds);
    if (duration.error) return res.status(400).json({ error: duration.error });
    if (!duration.skip) updates.duration_seconds = duration.duration;
    if (req.body?.position !== undefined) {
      const position = wholeNumber(req.body.position);
      if (position === null) return res.status(400).json({ error: 'position must be a whole number' });
      updates.position = position;
    }
    await scene.update(updates);
    res.json(sceneJson(scene));
  }));

  // Its cells go with it (the FK cascades); the elements stay.
  router.delete('/:id/scenes/:sceneId', owned, asyncHandler(async (req, res) => {
    const scene = await ownScene(req.composition, req.params.sceneId);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    await scene.destroy();
    res.json({ ok: true });
  }));

  // ---- elements ----

  // Body: { name, kind?, description?, position? }
  router.post('/:id/elements', owned, asyncHandler(async (req, res) => {
    const composition = req.composition;
    const name = text(req.body?.name, MAX_NAME_LENGTH);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const kind = req.body?.kind === undefined || req.body?.kind === null || req.body?.kind === ''
      ? 'voice'
      : String(req.body.kind);
    if (!ELEMENT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${ELEMENT_KINDS.join(', ')}` });
    }
    const count = await CompositionElement.count({ where: { composition_id: composition.id } });
    if (count >= MAX_ELEMENTS) {
      return res.status(400).json({ error: `a storyboard holds at most ${MAX_ELEMENTS} elements` });
    }
    const element = await CompositionElement.create({
      composition_id: composition.id,
      name,
      kind,
      description: text(req.body?.description, MAX_DESCRIPTION_LENGTH),
      position: wholeNumber(req.body?.position) ?? (await nextPosition(CompositionElement, composition.id)),
    });
    res.status(201).json(elementJson(element));
  }));

  // Body: { element_ids: [...] }
  router.put('/:id/elements/order', owned, asyncHandler(async (req, res) => {
    const { error } = await reorder(CompositionElement, req.composition, req.body?.element_ids, 'element');
    if (error) return res.status(400).json({ error });
    const elements = await CompositionElement.findAll({
      where: { composition_id: req.composition.id },
      order: [['position', 'ASC'], ['id', 'ASC']],
    });
    res.json(elements.map(elementJson));
  }));

  const ownElement = (composition, id) =>
    CompositionElement.findOne({ where: { id: Number(id) || 0, composition_id: composition.id } });

  // Body: { name?, kind?, description?, position? }
  router.put('/:id/elements/:elementId', owned, asyncHandler(async (req, res) => {
    const element = await ownElement(req.composition, req.params.elementId);
    if (!element) return res.status(404).json({ error: 'Element not found' });
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name, MAX_NAME_LENGTH);
      if (!name) return res.status(400).json({ error: 'name is required' });
      updates.name = name;
    }
    if (req.body?.kind !== undefined) {
      const kind = String(req.body.kind ?? '');
      if (!ELEMENT_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${ELEMENT_KINDS.join(', ')}` });
      }
      updates.kind = kind;
    }
    if (req.body?.description !== undefined) {
      updates.description = text(req.body.description, MAX_DESCRIPTION_LENGTH);
    }
    if (req.body?.position !== undefined) {
      const position = wholeNumber(req.body.position);
      if (position === null) return res.status(400).json({ error: 'position must be a whole number' });
      updates.position = position;
    }
    await element.update(updates);
    res.json(elementJson(element));
  }));

  // Its cells and every mapping of it onto every patch go with it.
  router.delete('/:id/elements/:elementId', owned, asyncHandler(async (req, res) => {
    const element = await ownElement(req.composition, req.params.elementId);
    if (!element) return res.status(404).json({ error: 'Element not found' });
    await element.destroy();
    res.json({ ok: true });
  }));

  // ---- cells ----

  // What an element does in a scene. One cell per pair, written whole: PUT
  // creates it or replaces it. Body: { action, note? }
  router.put('/:id/scenes/:sceneId/elements/:elementId', owned, asyncHandler(async (req, res) => {
    const [scene, element] = await Promise.all([
      ownScene(req.composition, req.params.sceneId),
      ownElement(req.composition, req.params.elementId),
    ]);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    if (!element) return res.status(404).json({ error: 'Element not found' });
    const action = req.body?.action === undefined || req.body?.action === null || req.body?.action === ''
      ? 'hold'
      : String(req.body.action);
    if (!CELL_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${CELL_ACTIONS.join(', ')}` });
    }
    const note = text(req.body?.note, MAX_NOTE_LENGTH);
    let cell = await CompositionSceneElement.findOne({
      where: { scene_id: scene.id, element_id: element.id },
    });
    if (cell) {
      await cell.update({ action, note });
      return res.json(cellJson(cell));
    }
    cell = await CompositionSceneElement.create({
      scene_id: scene.id,
      element_id: element.id,
      action,
      note,
    });
    res.status(201).json(cellJson(cell));
  }));

  // The element is not playing in that scene after all.
  router.delete('/:id/scenes/:sceneId/elements/:elementId', owned, asyncHandler(async (req, res) => {
    const [scene, element] = await Promise.all([
      ownScene(req.composition, req.params.sceneId),
      ownElement(req.composition, req.params.elementId),
    ]);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    if (!element) return res.status(404).json({ error: 'Element not found' });
    await CompositionSceneElement.destroy({ where: { scene_id: scene.id, element_id: element.id } });
    res.json({ ok: true });
  }));

  return router;
}
