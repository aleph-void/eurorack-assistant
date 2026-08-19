import { Router } from 'express';
import { requireOwnedPatch, resolveEndpoint } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function patchSettingRoutes(db) {
  const {
    PatchSetting,
  } = db.models;
  const router = Router();

  // Record how a control is dialed in for this patch (upsert per module
  // instance + component). Body: { patch_module_id, component_id, value }
  router.put('/:id/settings', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const target = await resolveEndpoint(db, patch, req.body?.patch_module_id, req.body?.component_id);
    if (target.error) return res.status(400).json({ error: target.error });
    if (target.component.type.endsWith('_jack')) {
      return res.status(400).json({ error: 'jacks are patched with cables, not settings' });
    }
    const value = String(req.body?.value ?? '').trim();
    if (!value) return res.status(400).json({ error: 'value is required' });
    const existing = await PatchSetting.findOne({
      where: {
        patch_id: patch.id,
        patch_module_id: target.pm.id,
        component_id: target.component.id,
      },
    });
    const setting = existing
      ? await existing.update({ value })
      : await PatchSetting.create({
          patch_id: patch.id,
          patch_module_id: target.pm.id,
          component_id: target.component.id,
          component_name: target.component.name,
          value,
        });
    res.status(existing ? 200 : 201).json({
      id: setting.id,
      patch_module_id: setting.patch_module_id,
      component_id: setting.component_id,
      component_name: setting.component_name,
      value: setting.value,
    });
  }));

  router.delete('/:id/settings/:settingId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const deleted = await PatchSetting.destroy({
      where: { id: Number(req.params.settingId) || 0, patch_id: patch.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Setting not found' });
    res.json({ ok: true });
  }));

  return router;
}
