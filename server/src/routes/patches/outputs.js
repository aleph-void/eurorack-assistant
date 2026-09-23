import { Router } from 'express';
import { outputJson } from '../../services/patchDetail.js';
import { requireOwnedPatch, resolveEndpoint } from './helpers.js';
import { EXIT_JACK_ERROR, EXIT_JACK_TYPES } from '../../services/studioOutputs.js';
import { asyncHandler } from '../asyncHandler.js';

// Where sound leaves the system, as THIS patch keeps it. Copied from the
// racks when the patch is made (services/patchCreate.js) and edited here
// afterwards — a patch of a travelling case has different exits from the
// studio's, and gear declared inside the patch (the interface, the PA) is
// an exit no rack knows about.
export function patchOutputRoutes(db) {
  const { PatchModule, PatchOutput } = db.models;
  const router = Router();

  const listJson = async (patch) =>
    (
      await PatchOutput.findAll({
        where: { patch_id: patch.id },
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    ).map((o) => outputJson(o));

  // Body: { patch_module_id, component_id? } — one of the patch's instances,
  // and an input or bidirectional jack of it (an analyzed module's or one
  // declared on the gear). No
  // jack is the instance as a whole: the output module, whichever of its
  // jacks the sound goes in at.
  router.post('/:id/outputs', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const componentId = req.body?.component_id;
    const whole = componentId === undefined || componentId === null || componentId === '';
    let pm;
    let component = null;
    if (whole) {
      pm = await PatchModule.findOne({
        where: { id: Number(req.body?.patch_module_id) || 0, patch_id: patch.id },
      });
      if (!pm) return res.status(400).json({ error: 'that module is not part of this patch' });
    } else {
      const target = await resolveEndpoint(db, patch, req.body?.patch_module_id, componentId);
      if (target.error) return res.status(400).json({ error: target.error });
      if (!EXIT_JACK_TYPES.includes(target.component.type)) {
        return res.status(400).json({ error: EXIT_JACK_ERROR });
      }
      ({ pm, component } = target);
    }
    const existing = await PatchOutput.findOne({
      where: { patch_id: patch.id, patch_module_id: pm.id, component_id: component?.id ?? null },
    });
    if (existing) {
      return res.status(409).json({
        error: component
          ? `'${component.name}' is already one of this patch's outputs`
          : "that module is already one of this patch's outputs",
      });
    }
    const last = await PatchOutput.max('position', { where: { patch_id: patch.id } });
    await PatchOutput.create({
      patch_id: patch.id,
      patch_module_id: pm.id,
      component_id: component?.id ?? null,
      component_name: component?.name ?? null,
      position: (Number(last) || 0) + 1,
    });
    res.status(201).json({ outputs: await listJson(patch) });
  }));

  router.delete('/:id/outputs/:outputId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const deleted = await PatchOutput.destroy({
      where: { id: Number(req.params.outputId) || 0, patch_id: patch.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Output not found' });
    res.json({ outputs: await listJson(patch) });
  }));

  return router;
}
