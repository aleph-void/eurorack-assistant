import { Router } from 'express';
import { outputJson } from '../../services/patchDetail.js';
import { requireOwnedPatch, resolveEndpoint } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// Where sound leaves the system, as THIS patch keeps it. Copied from the
// racks when the patch is made (services/patchCreate.js) and edited here
// afterwards — a patch of a travelling case has different exits from the
// studio's, and gear declared inside the patch (the interface, the PA) is
// an exit no rack knows about.
export function patchOutputRoutes(db) {
  const { PatchOutput } = db.models;
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

  // Body: { patch_module_id, component_id } — a jack of one of the patch's
  // instances, an analyzed module's or one declared on the gear.
  router.post('/:id/outputs', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const target = await resolveEndpoint(db, patch, req.body?.patch_module_id, req.body?.component_id);
    if (target.error) return res.status(400).json({ error: target.error });
    if (!target.component.type.endsWith('_jack')) {
      return res.status(400).json({ error: 'an output has to be a jack — sound leaves through a cable' });
    }
    const existing = await PatchOutput.findOne({
      where: { patch_id: patch.id, patch_module_id: target.pm.id, component_id: target.component.id },
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: `'${target.component.name}' is already one of this patch's outputs` });
    }
    const last = await PatchOutput.max('position', { where: { patch_id: patch.id } });
    await PatchOutput.create({
      patch_id: patch.id,
      patch_module_id: target.pm.id,
      component_id: target.component.id,
      component_name: target.component.name,
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
