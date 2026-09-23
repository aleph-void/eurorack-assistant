import { Router } from 'express';
import { ownRack } from './helpers.js';
import { rackOutputsJson } from '../../services/rackJson.js';
import { asyncHandler } from '../asyncHandler.js';

// Where sound leaves the rack: the jacks that feed the speakers, the
// interface, the mixer on the desk. A fact about the studio, so it is kept
// on the rack — module records are shared — and every patch made of the rack
// takes its own copy (services/patchCreate.js). One row per jack, added and
// removed one at a time.
export function rackOutputRoutes(db) {
  const { RackModule, ModuleComponent, RackOutput } = db.models;
  const router = Router();

  router.get('/:id/outputs', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  // Body: { module_id, component_id } — a jack of a module the rack holds.
  router.post('/:id/outputs', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const moduleId = Number(req.body?.module_id) || 0;
    const mapping = await RackModule.findOne({ where: { rack_id: rack.id, module_id: moduleId } });
    if (!mapping) return res.status(400).json({ error: 'that module is not in this rack' });
    const component = await ModuleComponent.findOne({
      where: { id: Number(req.body?.component_id) || 0, module_id: moduleId },
    });
    if (!component) {
      return res.status(400).json({ error: 'that component does not belong to this module' });
    }
    if (!component.type.endsWith('_jack')) {
      return res.status(400).json({ error: 'an output has to be a jack — sound leaves through a cable' });
    }
    const existing = await RackOutput.findOne({
      where: { rack_id: rack.id, module_id: moduleId, component_id: component.id },
    });
    if (existing) {
      return res.status(409).json({ error: `'${component.name}' is already one of this rack's outputs` });
    }
    const last = await RackOutput.max('position', { where: { rack_id: rack.id } });
    await RackOutput.create({
      rack_id: rack.id,
      module_id: moduleId,
      component_id: component.id,
      position: (Number(last) || 0) + 1,
    });
    res.status(201).json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  router.delete('/:id/outputs/:outputId', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const deleted = await RackOutput.destroy({
      where: { id: Number(req.params.outputId) || 0, rack_id: rack.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Output not found' });
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  return router;
}
