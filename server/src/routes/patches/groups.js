import { Router } from 'express';
import { requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function patchGroupRoutes(db) {
  const {
    PatchModule,
    PatchGroup,
  } = db.models;
  const router = Router();

  // ---- groups (named buses / layers) ----

  const groupJson = (g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    position: g.position,
  });

  router.post('/:id/groups', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const existing = await PatchGroup.findAll({ where: { patch_id: patch.id } });
    if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `this patch already has a group named '${name}'` });
    }
    const group = await PatchGroup.create({
      patch_id: patch.id,
      name,
      description: String(req.body?.description || '').trim() || null,
      position: Number(req.body?.position) || existing.length + 1,
    });
    res.status(201).json(groupJson(group));
  }));

  router.put('/:id/groups/:groupId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const group = await PatchGroup.findOne({
      where: { id: Number(req.params.groupId) || 0, patch_id: patch.id },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = String(req.body.description || '').trim() || null;
    }
    if (req.body?.position !== undefined) updates.position = Number(req.body.position) || 0;
    await group.update(updates);
    res.json(groupJson(group));
  }));

  // Deleting a group leaves its members in the patch, ungrouped.
  router.delete('/:id/groups/:groupId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const group = await PatchGroup.findOne({
      where: { id: Number(req.params.groupId) || 0, patch_id: patch.id },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await db.sequelize.transaction(async (transaction) => {
      await PatchModule.update(
        { group_id: null },
        { where: { patch_id: patch.id, group_id: group.id }, transaction }
      );
      await group.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  return router;
}
