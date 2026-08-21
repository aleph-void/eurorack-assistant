import { Router } from 'express';
import { Op } from 'sequelize';
import { pairJacksByName } from '../../services/moduleBridges.js';
import { requireOwnedModule, userModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function moduleBridgeRoutes(db) {
  const { ModuleBridge, ModuleBridgeJack, ModuleComponent } = db.models;
  const router = Router();

  // ---- dual modules ----
  // Declare that this module is one half of a DUAL: two panels of one product
  // joined by a link cable rather than by patch cables (Omnitone 7Path's
  // ethernet pair). Jack N of one panel is wired to jack N of the other, and
  // those jacks are bidirectional — whichever end a cable goes into is the
  // input, and the matching jack on the OPPOSITE panel is the output.
  //
  // Body: { bridge_module_id, jacks?: [{ a_component_id, b_component_id }],
  //         description? }. bridge_module_id may be THIS module: a dual
  //  racked as one record with quantity 2 pairs its two instances up.
  //  Without an explicit jack list the two panels pair by jack name, which is
  //  how identical panels are labelled.
  router.post('/:id/bridges', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const partner = await userModule(db, req.user.id, req.body?.bridge_module_id);
    if (!partner) {
      return res
        .status(400)
        .json({ error: 'bridge_module_id must be a module in one of your racks' });
    }
    const selfPair = partner.id === module.id;
    if (selfPair && partner.quantity < 2) {
      return res.status(400).json({
        error:
          'a module is only its own other half when you have two of them — rack a second one, or name the other panel',
      });
    }
    const existing = await ModuleBridge.findOne({
      where: {
        [Op.or]: [
          { a_module_id: module.id, b_module_id: partner.id },
          { a_module_id: partner.id, b_module_id: module.id },
        ],
      },
    });
    if (existing) {
      return res.status(409).json({ error: 'these two panels are already declared a dual' });
    }

    const components = await ModuleComponent.findAll({
      where: { module_id: [...new Set([module.id, partner.id])] },
      order: [['id', 'ASC']],
    });
    const componentsOf = (moduleId) => components.filter((c) => c.module_id === moduleId);
    const requested = Array.isArray(req.body?.jacks) ? req.body.jacks : [];
    let jackRows = [];
    if (requested.length > 0) {
      const aJacks = componentsOf(module.id);
      const bJacks = componentsOf(partner.id);
      for (const pair of requested) {
        const a = aJacks.find((c) => c.id === Number(pair?.a_component_id));
        const b = bJacks.find((c) => c.id === Number(pair?.b_component_id));
        if (!a || !b || !a.type.endsWith('_jack') || !b.type.endsWith('_jack')) {
          return res
            .status(400)
            .json({ error: 'every paired wire must name a jack on each of the two panels' });
        }
        jackRows.push({ a_component_id: a.id, b_component_id: b.id });
      }
    } else if (pairJacksByName(componentsOf(module.id), componentsOf(partner.id)).length === 0) {
      return res.status(400).json({
        error:
          'these two panels share no jack names — pair the wires up explicitly when the panels are labelled differently',
      });
    }

    let bridge;
    await db.sequelize.transaction(async (transaction) => {
      bridge = await ModuleBridge.create(
        {
          a_module_id: module.id,
          b_module_id: partner.id,
          description: String(req.body?.description || '').trim() || null,
        },
        { transaction }
      );
      if (jackRows.length > 0) {
        await ModuleBridgeJack.bulkCreate(
          jackRows.map((j) => ({ ...j, bridge_id: bridge.id })),
          { transaction }
        );
      }
    });
    res.status(201).json({
      id: bridge.id,
      module_id: partner.id,
      manufacturer: partner.manufacturer,
      name: partner.name,
      self: selfPair,
      description: bridge.description,
      jacks: jackRows,
    });
  }));

  router.delete('/:id/bridges/:bridgeId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    // Either panel may undo it.
    const bridge = await ModuleBridge.findOne({
      where: {
        id: Number(req.params.bridgeId) || 0,
        [Op.or]: [{ a_module_id: module.id }, { b_module_id: module.id }],
      },
    });
    if (!bridge) return res.status(404).json({ error: 'Dual link not found' });
    await db.sequelize.transaction(async (transaction) => {
      await ModuleBridgeJack.destroy({ where: { bridge_id: bridge.id }, transaction });
      await bridge.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  return router;
}
