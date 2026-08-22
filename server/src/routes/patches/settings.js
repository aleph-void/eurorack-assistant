import { Router } from 'express';
import { requireOwnedPatch, resolveEndpoint } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function patchSettingRoutes(db) {
  const {
    ModuleParameter,
    PatchModule,
    PatchSetting,
  } = db.models;
  const router = Router();

  const settingJson = (setting) => ({
    id: setting.id,
    patch_module_id: setting.patch_module_id,
    component_id: setting.component_id,
    component_name: setting.component_name,
    parameter_id: setting.parameter_id,
    parameter_name: setting.parameter_name,
    value: setting.value,
  });

  // A setting of a MENU PARAMETER — the settings a module keeps behind its
  // encoder rather than under a control of its own. The parameter says which
  // component it belongs to (an output jack's clock division belongs to that
  // jack), so the body need only name the parameter; and unlike a control,
  // one jack carries as many of these as its menu has entries.
  async function resolveParameter(patch, patchModuleId, parameterId) {
    const pm = await PatchModule.findOne({
      where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
    });
    if (!pm) return { error: 'that module is not part of this patch' };
    if (!pm.module_id) {
      return { error: 'that module is not in the rack any more, so its menu is unknown' };
    }
    const parameter = await ModuleParameter.findOne({
      where: { id: Number(parameterId) || 0, module_id: pm.module_id },
    });
    if (!parameter) return { error: 'that parameter does not belong to this module' };
    return { pm, parameter };
  }

  // Record how a control is dialed in for this patch (upsert per module
  // instance + component, or per module instance + menu parameter).
  // Body: { patch_module_id, component_id, value } — or
  //       { patch_module_id, parameter_id, value }
  router.put('/:id/settings', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const value = String(req.body?.value ?? '').trim();
    if (!value) return res.status(400).json({ error: 'value is required' });

    let where;
    let fields;
    if (req.body?.parameter_id !== undefined && req.body?.parameter_id !== null && req.body?.parameter_id !== '') {
      const target = await resolveParameter(patch, req.body?.patch_module_id, req.body.parameter_id);
      if (target.error) return res.status(400).json({ error: target.error });
      // The name of the component the parameter sits on, snapshotted like
      // every other name a patch keeps: it is a menu entry of THAT jack, and
      // the patch has to still say so once the module is re-analyzed.
      let componentName = null;
      if (target.parameter.component_id) {
        const component = await db.models.ModuleComponent.findByPk(target.parameter.component_id);
        componentName = component?.name ?? null;
      }
      where = {
        patch_id: patch.id,
        patch_module_id: target.pm.id,
        parameter_id: target.parameter.id,
      };
      fields = {
        ...where,
        component_id: target.parameter.component_id,
        component_name: componentName,
        parameter_name: target.parameter.name,
        value,
      };
    } else {
      const target = await resolveEndpoint(db, patch, req.body?.patch_module_id, req.body?.component_id);
      if (target.error) return res.status(400).json({ error: target.error });
      if (target.component.type.endsWith('_jack')) {
        return res.status(400).json({
          error: 'jacks are patched with cables, not settings — a jack takes a value only through a menu parameter',
        });
      }
      where = {
        patch_id: patch.id,
        patch_module_id: target.pm.id,
        component_id: target.component.id,
        parameter_id: null,
      };
      fields = { ...where, component_name: target.component.name, parameter_name: null, value };
    }

    const existing = await PatchSetting.findOne({ where });
    const setting = existing
      ? await existing.update(fields)
      : await PatchSetting.create(fields);
    res.status(existing ? 200 : 201).json(settingJson(setting));
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
