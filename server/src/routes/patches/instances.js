import { Router } from 'express';
import { Op } from 'sequelize';
import { moduleJson, portJson } from '../../services/patchDetail.js';
import { materializeBridges } from '../../services/moduleBridges.js';
import { PORT_KINDS } from '../../services/manualAnalyzer.js';
import { ownPatchModule, requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

const JACK_TYPES = ['input_jack', 'output_jack', 'bidirectional_jack'];

export function patchInstanceRoutes(db) {
  const {
    Rack,
    RackModule,
    Module,
    PatchModule,
    PatchGroup,
    PatchModulePort,
    PatchCable,
    PatchSetting,
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;
  const router = Router();

  // ---- instances: labels, groups, ad-hoc modules and external gear ----

  // Add something to the patch that the rack snapshot does not hold:
  //   { module_id }                        — another instance of a module you
  //                                          have racked (a second Batumi)
  //   { manufacturer, module_name }        — a module the rack does not hold
  //                                          (a borrowed A-140)
  //   { name, external: true }             — off-rack gear: a DAW, a MIDI
  //                                          interface, the monitors
  // Instances with no live module behind them declare their own connection
  // points with POST /:id/modules/:pmId/ports.
  router.post('/:id/modules', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const external = Boolean(req.body?.external);
    let manufacturer = String(req.body?.manufacturer || '').trim();
    let moduleName = String(req.body?.module_name || req.body?.name || '').trim();
    let moduleId = null;

    if (req.body?.module_id !== undefined && req.body?.module_id !== null && !external) {
      // Only modules the user actually has racked can be referenced live.
      const mapping = await RackModule.findOne({
        where: { module_id: Number(req.body.module_id) || 0 },
        include: [{ model: Rack, where: { user_id: req.user.id } }, Module],
      });
      if (!mapping || !mapping.Module) {
        return res.status(400).json({ error: 'module_id must be a module in one of your racks' });
      }
      moduleId = mapping.Module.id;
      manufacturer = mapping.Module.manufacturer;
      moduleName = mapping.Module.name;
    }
    if (!moduleName) {
      return res
        .status(400)
        .json({ error: 'module_id, or a name for the module or piece of gear, is required' });
    }
    // Count instances by the manufacturer that will actually be stored, or a
    // second nameless piece of external gear starts over at #1.
    manufacturer = manufacturer || (external ? 'external' : '');
    const instances = await PatchModule.findAll({
      where: { patch_id: patch.id },
    });
    const instance = moduleId
      ? instances.filter((pm) => pm.module_id === moduleId).length + 1
      : instances.filter(
          (pm) =>
            pm.module_id === null &&
            pm.module_name.toLowerCase() === moduleName.toLowerCase() &&
            (pm.manufacturer || '').toLowerCase() === manufacturer.toLowerCase()
        ).length + 1;
    const pm = await PatchModule.create({
      patch_id: patch.id,
      module_id: moduleId,
      manufacturer,
      module_name: moduleName,
      instance,
      external,
      label: String(req.body?.label || '').trim() || null,
    });
    // Adding the second panel of a dual module wires the pair up: the link
    // cable between them is a fact about the hardware, not a patch decision.
    if (moduleId) await materializeBridges(db, patch);
    res.status(201).json(moduleJson(pm, { live: Boolean(moduleId), components: [] }));
  }));

  // Name an instance's role in this patch, file it under a bus/layer, and
  // correct the name it is snapshotted under. Body:
  // { label?, group_id?, manufacturer?, module_name? } (group_id null clears
  // it). The two name columns are what the patch renders, live module behind
  // it or not, so a mistyped manufacturer or module name is fixed here; both
  // must still say something, and are trimmed.
  router.put('/:id/modules/:pmId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const pm = await ownPatchModule(db, patch, req.params.pmId);
    if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
    const updates = {};
    if (req.body?.label !== undefined) {
      updates.label = String(req.body.label || '').trim() || null;
    }
    if (req.body?.group_id !== undefined) {
      if (req.body.group_id === null || req.body.group_id === '') {
        updates.group_id = null;
      } else {
        const group = await PatchGroup.findOne({
          where: { id: Number(req.body.group_id) || 0, patch_id: patch.id },
        });
        if (!group) return res.status(400).json({ error: 'group_id must be a group of this patch' });
        updates.group_id = group.id;
      }
    }
    for (const field of ['manufacturer', 'module_name']) {
      if (req.body?.[field] === undefined) continue;
      const value = String(req.body[field] ?? '').trim();
      if (!value) return res.status(400).json({ error: `${field} cannot be empty` });
      updates[field] = value;
    }
    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ error: 'label, group_id, manufacturer or module_name is required' });
    }
    await pm.update(updates);
    res.json(moduleJson(pm, { live: pm.module_id !== null, components: [] }));
  }));

  // Remove an instance from the patch, along with everything patched into it.
  router.delete('/:id/modules/:pmId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const pm = await ownPatchModule(db, patch, req.params.pmId);
    if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
    await db.sequelize.transaction(async (transaction) => {
      await PatchCable.destroy({
        where: {
          patch_id: patch.id,
          [Op.or]: [{ from_patch_module_id: pm.id }, { to_patch_module_id: pm.id }],
        },
        transaction,
      });
      await PatchSetting.destroy({ where: { patch_module_id: pm.id }, transaction });
      await PatchModulePort.destroy({ where: { patch_module_id: pm.id }, transaction });
      const links = await PatchModuleLink.findAll({
        where: {
          patch_id: patch.id,
          [Op.or]: [{ a_patch_module_id: pm.id }, { b_patch_module_id: pm.id }],
        },
        transaction,
      });
      if (links.length > 0) {
        await PatchModuleLinkJack.destroy({
          where: { link_id: links.map((l) => l.id) },
          transaction,
        });
        await PatchModuleLink.destroy({ where: { id: links.map((l) => l.id) }, transaction });
      }
      await pm.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  // Declare a connection point on an instance with no analyzed module behind
  // it. Body: { name, type?, port_kind?, description? }
  router.post('/:id/modules/:pmId/ports', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const pm = await ownPatchModule(db, patch, req.params.pmId);
    if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
    if (pm.module_id !== null && (await Module.count({ where: { id: pm.module_id } })) > 0) {
      return res.status(400).json({
        error: "this module's connections come from its analyzed components, not from the patch",
      });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const type = String(req.body?.type || 'input_jack').trim().toLowerCase();
    if (!JACK_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${JACK_TYPES.join(', ')}` });
    }
    const kind = String(req.body?.port_kind || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (kind && !PORT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `port_kind must be one of: ${PORT_KINDS.join(', ')}` });
    }
    const existing = await PatchModulePort.findAll({ where: { patch_module_id: pm.id } });
    if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `'${name}' is already declared on this module` });
    }
    const port = await PatchModulePort.create({
      patch_module_id: pm.id,
      name,
      type,
      port_kind: kind || null,
      description: String(req.body?.description || '').trim() || null,
      position: existing.length + 1,
    });
    res.status(201).json({ ...portJson(port), patch_module_id: pm.id });
  }));

  router.delete('/:id/modules/:pmId/ports/:portId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const pm = await ownPatchModule(db, patch, req.params.pmId);
    if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
    const port = await PatchModulePort.findOne({
      where: { id: Number(req.params.portId) || 0, patch_module_id: pm.id },
    });
    if (!port) return res.status(404).json({ error: 'Port not found' });
    await db.sequelize.transaction(async (transaction) => {
      await PatchCable.destroy({
        where: {
          patch_id: patch.id,
          [Op.or]: [
            { from_patch_module_id: pm.id, from_component_id: port.id },
            { to_patch_module_id: pm.id, to_component_id: port.id },
          ],
        },
        transaction,
      });
      await port.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  return router;
}
