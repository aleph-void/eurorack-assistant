import { Router } from 'express';
import { Op } from 'sequelize';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  compositionJson,
  compositionNamed,
  isCompositionNameConflict,
  loadCompositionDetail,
  nameTakenMessage,
  text,
} from '../../services/compositions.js';
import { requireOwnedComposition } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// The composition records themselves: list, create, whole detail, rename and
// describe, delete.
export function compositionCoreRoutes(db) {
  const {
    Composition,
    CompositionScene,
    CompositionElement,
    CompositionPatch,
    CompositionMapping,
    Patch,
  } = db.models;
  const router = Router();

  // Paged the way the patch list is (routes/patches/core.js): by id, so a
  // composition made while the list is read lands above the first page
  // rather than shifting an offset window.
  const DEFAULT_PAGE = 100;
  const MAX_PAGE = 500;

  // A tempo is a number of beats per minute or nothing; a typo of a
  // thousand is refused rather than stored.
  const readTempo = (value) => {
    if (value === undefined) return { skip: true };
    if (value === null || value === '') return { tempo: null };
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 999) {
      return { error: 'tempo_bpm must be a number of beats per minute' };
    }
    return { tempo: n };
  };

  // Every write that takes a name checks it is free first, then writes
  // through this: two requests can both find one free, and the unique index
  // behind the check catches the second with the same 409.
  const takingName = async (name, res, write) => {
    try {
      await write();
      return true;
    } catch (e) {
      if (!isCompositionNameConflict(e)) throw e;
      res.status(409).json({ error: nameTakenMessage(name) });
      return false;
    }
  };

  // Scene, element and patch counts for a page of compositions, grouped in
  // JS off flat queries (pg-mem-friendly).
  const countsFor = async (ids) => {
    if (ids.length === 0) return () => ({});
    const [scenes, elements, realizations] = await Promise.all([
      CompositionScene.findAll({ where: { composition_id: ids }, attributes: ['composition_id'] }),
      CompositionElement.findAll({ where: { composition_id: ids }, attributes: ['composition_id'] }),
      CompositionPatch.findAll({ where: { composition_id: ids }, attributes: ['composition_id'] }),
    ]);
    const tally = (rows) => {
      const map = new Map();
      for (const r of rows) map.set(r.composition_id, (map.get(r.composition_id) ?? 0) + 1);
      return map;
    };
    const s = tally(scenes);
    const e = tally(elements);
    const p = tally(realizations);
    return (id) => ({
      scene_count: s.get(id) ?? 0,
      element_count: e.get(id) ?? 0,
      patch_count: p.get(id) ?? 0,
    });
  };

  // GET /api/compositions?limit&before — one page of the user's compositions.
  // GET /api/compositions?patch_id=12 — the ones mapped onto that patch,
  // each with the id of its mapping and how many bindings it holds, which is
  // what the patch's Compositions page lists.
  router.get('/', asyncHandler(async (req, res) => {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
    const before = Math.max(0, Number(req.query.before) || 0);
    const mine = { user_id: req.user.id };

    if (req.query.patch_id !== undefined) {
      const patch = await Patch.findOne({
        where: { id: Number(req.query.patch_id) || 0, user_id: req.user.id },
      });
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const realizations = await CompositionPatch.findAll({
        where: { patch_id: patch.id },
        order: [['id', 'ASC']],
      });
      const compositions = realizations.length
        ? await Composition.findAll({
            where: { ...mine, id: realizations.map((r) => r.composition_id) },
            order: [['name', 'ASC'], ['id', 'ASC']],
          })
        : [];
      const mappings = realizations.length
        ? await CompositionMapping.findAll({
            where: { composition_patch_id: realizations.map((r) => r.id) },
            attributes: ['composition_patch_id', 'element_id'],
          })
        : [];
      const byComposition = new Map(realizations.map((r) => [r.composition_id, r]));
      const mapped = new Map();
      for (const m of mappings) {
        if (!mapped.has(m.composition_patch_id)) mapped.set(m.composition_patch_id, new Set());
        mapped.get(m.composition_patch_id).add(m.element_id);
      }
      const counts = await countsFor(compositions.map((c) => c.id));
      const rows = compositions.map((c) => {
        const r = byComposition.get(c.id);
        return compositionJson(c, {
          ...counts(c.id),
          realization_id: r.id,
          mapped_element_count: mapped.get(r.id)?.size ?? 0,
          notes: r.notes ?? null,
        });
      });
      return res.json({
        total: rows.length,
        limit: rows.length,
        has_more: false,
        next_before: null,
        compositions: rows,
      });
    }

    const total = await Composition.count({ where: mine });
    const rows = await Composition.findAll({
      where: before ? { ...mine, id: { [Op.lt]: before } } : mine,
      order: [['id', 'DESC']],
      limit: limit + 1,
    });
    const has_more = rows.length > limit;
    const page = has_more ? rows.slice(0, limit) : rows;
    const counts = await countsFor(page.map((c) => c.id));
    res.json({
      total,
      limit,
      has_more,
      next_before: has_more ? page[page.length - 1].id : null,
      compositions: page.map((c) => compositionJson(c, counts(c.id))),
    });
  }));

  // Body: { name, description?, tempo_bpm? }
  router.post('/', asyncHandler(async (req, res) => {
    const name = text(req.body?.name, MAX_NAME_LENGTH);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (await compositionNamed(db, req.user.id, name)) {
      return res.status(409).json({ error: nameTakenMessage(name) });
    }
    const tempo = readTempo(req.body?.tempo_bpm);
    if (tempo.error) return res.status(400).json({ error: tempo.error });
    let composition;
    const ok = await takingName(name, res, async () => {
      composition = await Composition.create({
        user_id: req.user.id,
        name,
        description: text(req.body?.description, MAX_DESCRIPTION_LENGTH),
        tempo_bpm: tempo.skip ? null : tempo.tempo,
      });
    });
    if (!ok) return;
    res.status(201).json(compositionJson(composition, { scene_count: 0, element_count: 0, patch_count: 0 }));
  }));

  // The whole storyboard, and the patches it is mapped onto.
  router.get('/:id', requireOwnedComposition(db), asyncHandler(async (req, res) => {
    res.json(await loadCompositionDetail(db, req.composition));
  }));

  // Body: { name?, description?, tempo_bpm? } — each omitted field is left
  // alone.
  router.put('/:id', requireOwnedComposition(db), asyncHandler(async (req, res) => {
    const composition = req.composition;
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name, MAX_NAME_LENGTH);
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (await compositionNamed(db, req.user.id, name, { exceptId: composition.id })) {
        return res.status(409).json({ error: nameTakenMessage(name) });
      }
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = text(req.body.description, MAX_DESCRIPTION_LENGTH);
    }
    const tempo = readTempo(req.body?.tempo_bpm);
    if (tempo.error) return res.status(400).json({ error: tempo.error });
    if (!tempo.skip) updates.tempo_bpm = tempo.tempo;
    const ok = await takingName(updates.name ?? composition.name, res, () =>
      composition.update(updates)
    );
    if (!ok) return;
    res.json(compositionJson(composition));
  }));

  // Everything under it goes with it: scenes, elements, cells, and every
  // mapping onto every patch. The patches themselves are untouched.
  router.delete('/:id', requireOwnedComposition(db), asyncHandler(async (req, res) => {
    await req.composition.destroy();
    res.json({ ok: true });
  }));

  return router;
}
