import { Router } from 'express';
import { cableJson } from '../../services/patchDetail.js';
import { cableProblem, pairedJack, requireOwnedPatch, resolveEndpoint } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// Cables. The legality rules (mult groups, one-cable inputs, port kinds,
// switch and bridge exemptions) live in helpers.js cableProblem().
export function patchCableRoutes(db) {
  const {
    PatchCable,
  } = db.models;
  const router = Router();

  // Plug a cable: an output jack into an input jack. Body:
  // { from_patch_module_id, from_component_id, to_patch_module_id,
  //   to_component_id, note?, optional?, stacked?, alt_group?, pair? }
  // With pair: true and both ends part of a stereo pair, the second cable is
  // plugged at the same time — a stereo connection is one decision.
  router.post('/:id/cables', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const from = await resolveEndpoint(
      db,
      patch,
      req.body?.from_patch_module_id,
      req.body?.from_component_id
    );
    if (from.error) return res.status(400).json({ error: `from: ${from.error}` });
    const to = await resolveEndpoint(
      db,
      patch,
      req.body?.to_patch_module_id,
      req.body?.to_component_id
    );
    if (to.error) return res.status(400).json({ error: `to: ${to.error}` });

    const extras = {
      note: String(req.body?.note || '').trim() || null,
      optional: Boolean(req.body?.optional),
      stacked: Boolean(req.body?.stacked),
      alt_group: String(req.body?.alt_group || '').trim() || null,
    };

    const existing = await PatchCable.findAll({ where: { patch_id: patch.id } });
    const problem = await cableProblem(db, patch, from, to, existing);
    if (problem) return res.status(problem.status).json({ error: problem.error });

    // The second half of a stereo connection, when asked for and available.
    let second = null;
    if (req.body?.pair) {
      const fromPartner = await pairedJack(db, from.pm, from.component);
      const toPartner = await pairedJack(db, to.pm, to.component);
      if (!fromPartner || !toPartner) {
        return res.status(400).json({
          error: 'both jacks must be part of a recorded pair to patch them as one connection',
        });
      }
      second = {
        from: { pm: from.pm, component: fromPartner },
        to: { pm: to.pm, component: toPartner },
      };
      const secondProblem = await cableProblem(db, patch, second.from, second.to, existing);
      if (secondProblem) {
        return res
          .status(secondProblem.status)
          .json({ error: `the other half of the pair: ${secondProblem.error}` });
      }
    }

    const row = (end) => ({
      patch_id: patch.id,
      from_patch_module_id: end.from.pm.id,
      from_component_id: end.from.component.id,
      from_component_name: end.from.component.name,
      to_patch_module_id: end.to.pm.id,
      to_component_id: end.to.component.id,
      to_component_name: end.to.component.name,
      ...extras,
    });
    let cable;
    let paired = null;
    await db.sequelize.transaction(async (transaction) => {
      cable = await PatchCable.create(row({ from, to }), { transaction });
      if (second) paired = await PatchCable.create(row(second), { transaction });
    });
    res.status(201).json({ ...cableJson(cable), paired_cable: paired ? cableJson(paired) : null });
  }));

  // Annotate a cable: why it is there, whether it is provisional, whether it
  // is stacked onto the source jack, which alternative it belongs to.
  // Body: { note?, optional?, stacked?, alt_group? }
  router.put('/:id/cables/:cableId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const cable = await PatchCable.findOne({
      where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
    });
    if (!cable) return res.status(404).json({ error: 'Cable not found' });
    const updates = {};
    if (req.body?.note !== undefined) updates.note = String(req.body.note || '').trim() || null;
    if (req.body?.optional !== undefined) updates.optional = Boolean(req.body.optional);
    if (req.body?.stacked !== undefined) updates.stacked = Boolean(req.body.stacked);
    if (req.body?.alt_group !== undefined) {
      updates.alt_group = String(req.body.alt_group || '').trim() || null;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'note, optional, stacked or alt_group is required' });
    }
    await cable.update(updates);
    res.json(cableJson(cable));
  }));

  // Turn a cable around: the end it came from becomes the end it goes to.
  // Only ever legal when both jacks can play the other role — two mult jacks,
  // a bridged pair, a switch section — which is exactly where a cable is easy
  // to enter backwards. The swap is validated against every other cable in
  // the patch before the original is replaced.
  router.post('/:id/cables/:cableId/reverse', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const cable = await PatchCable.findOne({
      where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
    });
    if (!cable) return res.status(404).json({ error: 'Cable not found' });

    // The reversed cable starts where this one ended.
    const from = await resolveEndpoint(db, patch, cable.to_patch_module_id, cable.to_component_id);
    if (from.error) return res.status(400).json({ error: `from: ${from.error}` });
    const to = await resolveEndpoint(db, patch, cable.from_patch_module_id, cable.from_component_id);
    if (to.error) return res.status(400).json({ error: `to: ${to.error}` });

    // Judged against the patch as it will be once this cable is gone.
    const existing = (await PatchCable.findAll({ where: { patch_id: patch.id } })).filter(
      (c) => c.id !== cable.id
    );
    const problem = await cableProblem(db, patch, from, to, existing);
    if (problem) return res.status(problem.status).json({ error: problem.error });

    let reversed;
    await db.sequelize.transaction(async (transaction) => {
      await cable.destroy({ transaction });
      reversed = await PatchCable.create(
        {
          patch_id: patch.id,
          from_patch_module_id: from.pm.id,
          from_component_id: from.component.id,
          from_component_name: from.component.name,
          to_patch_module_id: to.pm.id,
          to_component_id: to.component.id,
          to_component_name: to.component.name,
          note: cable.note,
          optional: cable.optional,
          stacked: cable.stacked,
          alt_group: cable.alt_group,
        },
        { transaction }
      );
    });
    res.status(201).json(cableJson(reversed));
  }));

  // Move a cable: the same wire, re-plugged. One end usually stays where it
  // was and the other lands on a different jack — the picture's 'pick the plug
  // up and put it there' gesture. Body: the four endpoint fields of POST,
  // naming where BOTH ends should now be. Validated as the cable it will
  // become before the old one is touched, so a refused move leaves the patch
  // exactly as it was; annotations ride along like a reversal's do.
  router.post('/:id/cables/:cableId/move', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const cable = await PatchCable.findOne({
      where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
    });
    if (!cable) return res.status(404).json({ error: 'Cable not found' });

    const from = await resolveEndpoint(
      db,
      patch,
      req.body?.from_patch_module_id,
      req.body?.from_component_id
    );
    if (from.error) return res.status(400).json({ error: `from: ${from.error}` });
    const to = await resolveEndpoint(
      db,
      patch,
      req.body?.to_patch_module_id,
      req.body?.to_component_id
    );
    if (to.error) return res.status(400).json({ error: `to: ${to.error}` });

    // Judged against the patch as it will be once the old cable is gone —
    // pulling a plug out of an input frees that input in the same gesture.
    const existing = (await PatchCable.findAll({ where: { patch_id: patch.id } })).filter(
      (c) => c.id !== cable.id
    );
    const problem = await cableProblem(db, patch, from, to, existing);
    if (problem) return res.status(problem.status).json({ error: problem.error });

    let moved;
    await db.sequelize.transaction(async (transaction) => {
      await cable.destroy({ transaction });
      moved = await PatchCable.create(
        {
          patch_id: patch.id,
          from_patch_module_id: from.pm.id,
          from_component_id: from.component.id,
          from_component_name: from.component.name,
          to_patch_module_id: to.pm.id,
          to_component_id: to.component.id,
          to_component_name: to.component.name,
          note: cable.note,
          optional: cable.optional,
          stacked: cable.stacked,
          alt_group: cable.alt_group,
        },
        { transaction }
      );
    });
    res.status(201).json(cableJson(moved));
  }));

  router.delete('/:id/cables/:cableId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const deleted = await PatchCable.destroy({
      where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Cable not found' });
    res.json({ ok: true });
  }));

  return router;
}
