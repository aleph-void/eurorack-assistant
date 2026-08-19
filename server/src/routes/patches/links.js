import { Router } from 'express';
import { loadPatchDetail as loadPatchDetailFor } from '../../services/patchDetail.js';
import { ownPatchModule, requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

const LINK_KINDS = ['expander', 'bridge'];

export function patchLinkRoutes(db) {
  const {
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;
  const router = Router();

  // ---- links between instances (expander panels, bridges) ----

  // Body: { a_patch_module_id, b_patch_module_id, kind: 'expander'|'bridge',
  //         jacks?: [{ a_component_id, b_component_id }], description? }
  // A bridge with no explicit jack list pairs the two panels' jacks by name,
  // which is exactly how a 7Path pair works (jack 4 ↔ jack 4).
  router.post('/:id/links', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const a = await ownPatchModule(db, patch, req.body?.a_patch_module_id);
    const b = await ownPatchModule(db, patch, req.body?.b_patch_module_id);
    if (!a || !b) {
      return res.status(400).json({ error: 'both modules must be part of this patch' });
    }
    if (a.id === b.id) {
      return res.status(400).json({ error: 'a module cannot be linked to itself' });
    }
    const kind = String(req.body?.kind || 'expander').trim().toLowerCase();
    if (!LINK_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${LINK_KINDS.join(', ')}` });
    }
    const existing = await PatchModuleLink.findAll({ where: { patch_id: patch.id } });
    if (
      existing.some(
        (l) =>
          (l.a_patch_module_id === a.id && l.b_patch_module_id === b.id) ||
          (l.a_patch_module_id === b.id && l.b_patch_module_id === a.id)
      )
    ) {
      return res.status(409).json({ error: 'these two modules are already linked' });
    }

    const detail = await loadPatchDetailFor(db, patch);
    const jacksOf = (pm) =>
      (detail.topology.jacksByPatchModule.get(pm.id) || []).filter((c) => c.type.endsWith('_jack'));
    let jackRows = [];
    if (kind === 'bridge') {
      const requested = Array.isArray(req.body?.jacks) ? req.body.jacks : [];
      const aJacks = jacksOf(a);
      const bJacks = jacksOf(b);
      if (requested.length > 0) {
        for (const pair of requested) {
          const aJack = aJacks.find((c) => c.id === Number(pair?.a_component_id));
          const bJack = bJacks.find((c) => c.id === Number(pair?.b_component_id));
          if (!aJack || !bJack) {
            return res
              .status(400)
              .json({ error: 'every bridged pair must name a jack on each of the two modules' });
          }
          jackRows.push({
            a_component_id: aJack.id,
            a_component_name: aJack.name,
            b_component_id: bJack.id,
            b_component_name: bJack.name,
          });
        }
      } else {
        const byName = new Map(bJacks.map((c) => [c.name.trim().toLowerCase(), c]));
        for (const aJack of aJacks) {
          const bJack = byName.get(aJack.name.trim().toLowerCase());
          if (!bJack) continue;
          jackRows.push({
            a_component_id: aJack.id,
            a_component_name: aJack.name,
            b_component_id: bJack.id,
            b_component_name: bJack.name,
          });
        }
      }
      if (jackRows.length === 0) {
        return res.status(400).json({
          error:
            'a bridge needs at least one pair of jacks — name them explicitly when the two panels use different labels',
        });
      }
    }

    let link;
    await db.sequelize.transaction(async (transaction) => {
      link = await PatchModuleLink.create(
        {
          patch_id: patch.id,
          a_patch_module_id: a.id,
          b_patch_module_id: b.id,
          kind,
          description: String(req.body?.description || '').trim() || null,
        },
        { transaction }
      );
      if (jackRows.length > 0) {
        await PatchModuleLinkJack.bulkCreate(
          jackRows.map((j) => ({ ...j, link_id: link.id })),
          { transaction }
        );
      }
    });
    res.status(201).json({
      id: link.id,
      kind: link.kind,
      a_patch_module_id: link.a_patch_module_id,
      b_patch_module_id: link.b_patch_module_id,
      description: link.description,
      jacks: jackRows,
    });
  }));

  router.delete('/:id/links/:linkId', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const link = await PatchModuleLink.findOne({
      where: { id: Number(req.params.linkId) || 0, patch_id: patch.id },
    });
    if (!link) return res.status(404).json({ error: 'Link not found' });
    await db.sequelize.transaction(async (transaction) => {
      await PatchModuleLinkJack.destroy({ where: { link_id: link.id }, transaction });
      await link.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  return router;
}
