import { Router } from 'express';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_MAPPINGS_PER_ELEMENT,
  MAX_NOTE_LENGTH,
  loadRealization,
  mappingJson,
  realizationSummaryJson,
  resolveMappingTarget,
  text,
} from '../../services/compositions.js';
import { requireOwnedComposition, requireOwnedRealization, wholeNumber } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// A composition mapped onto a patch: the pair, and the bindings under it
// that say which instance, component, bus or cable realises each element.
export function compositionMappingRoutes(db) {
  const { Patch, CompositionElement, CompositionPatch, CompositionMapping } = db.models;
  const router = Router();

  // Map this composition onto one of the user's patches. Body: { patch_id,
  // notes? }. Mapping it onto the same patch twice is a 409: the pair is the
  // record, and the second request is asking for the one that exists.
  router.post('/:id/patches', requireOwnedComposition(db), asyncHandler(async (req, res) => {
    const composition = req.composition;
    const patchId = wholeNumber(req.body?.patch_id);
    if (!patchId) return res.status(400).json({ error: 'patch_id is required' });
    const patch = await Patch.findOne({ where: { id: patchId, user_id: req.user.id } });
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const existing = await CompositionPatch.findOne({
      where: { composition_id: composition.id, patch_id: patch.id },
    });
    if (existing) {
      return res.status(409).json({ error: `'${composition.name}' is already mapped onto '${patch.name}'` });
    }
    const realization = await CompositionPatch.create({
      composition_id: composition.id,
      patch_id: patch.id,
      notes: text(req.body?.notes, MAX_DESCRIPTION_LENGTH),
    });
    res.status(201).json(realizationSummaryJson(realization, patch, {
      mapping_count: 0,
      mapped_element_count: 0,
    }));
  }));

  const realized = requireOwnedRealization(db);

  // The mapping whole: the pair's notes, the elements, and every binding
  // with whether its target is still in the patch.
  router.get('/:id/patches/:patchId', realized, asyncHandler(async (req, res) => {
    res.json(await loadRealization(db, req.composition, req.realization, req.patch));
  }));

  // Body: { notes }
  router.put('/:id/patches/:patchId', realized, asyncHandler(async (req, res) => {
    const updates = {};
    if (req.body?.notes !== undefined) updates.notes = text(req.body.notes, MAX_DESCRIPTION_LENGTH);
    await req.realization.update(updates);
    res.json(realizationSummaryJson(req.realization, req.patch));
  }));

  // Unmapping takes every binding with it; the composition and the patch
  // are both untouched.
  router.delete('/:id/patches/:patchId', realized, asyncHandler(async (req, res) => {
    await req.realization.destroy();
    res.json({ ok: true });
  }));

  // Bind an element to something in the patch. Body: { element_id, and one
  // of patch_module_id (+ component_id) | group_id | cable_id, note? }
  router.post('/:id/patches/:patchId/mappings', realized, asyncHandler(async (req, res) => {
    const elementId = wholeNumber(req.body?.element_id);
    const element = elementId
      ? await CompositionElement.findOne({
          where: { id: elementId, composition_id: req.composition.id },
        })
      : null;
    if (!element) return res.status(404).json({ error: 'Element not found' });
    const { target, error } = await resolveMappingTarget(db, req.patch, req.body || {});
    if (error) return res.status(400).json({ error });
    const siblings = await CompositionMapping.findAll({
      where: { composition_patch_id: req.realization.id, element_id: element.id },
      order: [['position', 'DESC']],
    });
    if (siblings.length >= MAX_MAPPINGS_PER_ELEMENT) {
      return res.status(400).json({
        error: `an element is realised by at most ${MAX_MAPPINGS_PER_ELEMENT} things`,
      });
    }
    // The same thing bound to the same element twice says nothing new.
    const same = siblings.find(
      (m) =>
        m.patch_module_id === target.patch_module_id &&
        m.component_id === target.component_id &&
        m.group_id === target.group_id &&
        m.cable_id === target.cable_id
    );
    if (same) {
      return res.status(409).json({ error: `'${element.name}' is already mapped to ${target.target_label}` });
    }
    const mapping = await CompositionMapping.create({
      composition_patch_id: req.realization.id,
      element_id: element.id,
      ...target,
      note: text(req.body?.note, MAX_NOTE_LENGTH),
      position: (siblings[0]?.position ?? -1) + 1,
    });
    res.status(201).json(mappingJson(mapping));
  }));

  const ownMapping = (realization, id) =>
    CompositionMapping.findOne({
      where: { id: Number(id) || 0, composition_patch_id: realization.id },
    });

  // Body: { note?, position? } — a binding's TARGET is not edited; a wrong
  // one is removed and the right one added, which is what the page offers.
  router.put('/:id/patches/:patchId/mappings/:mappingId', realized, asyncHandler(async (req, res) => {
    const mapping = await ownMapping(req.realization, req.params.mappingId);
    if (!mapping) return res.status(404).json({ error: 'Mapping not found' });
    const updates = {};
    if (req.body?.note !== undefined) updates.note = text(req.body.note, MAX_NOTE_LENGTH);
    if (req.body?.position !== undefined) {
      const position = wholeNumber(req.body.position);
      if (position === null) return res.status(400).json({ error: 'position must be a whole number' });
      updates.position = position;
    }
    await mapping.update(updates);
    res.json(mappingJson(mapping));
  }));

  router.delete('/:id/patches/:patchId/mappings/:mappingId', realized, asyncHandler(async (req, res) => {
    const mapping = await ownMapping(req.realization, req.params.mappingId);
    if (!mapping) return res.status(404).json({ error: 'Mapping not found' });
    await mapping.destroy();
    res.json({ ok: true });
  }));

  return router;
}
