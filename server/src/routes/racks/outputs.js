import { Router } from 'express';
import { ownRack } from './helpers.js';
import { rackOutputsJson } from '../../services/rackJson.js';
import { outputJack } from '../../services/racks.js';
import { asyncHandler } from '../asyncHandler.js';

// Where sound leaves the rack: the jacks that feed the speakers, the
// interface, the mixer on the desk. A fact about the studio, so it is kept
// on the rack — module records are shared — and every patch made of the rack
// takes its own copy (services/patchCreate.js). One row per jack, added and
// removed one at a time. A rack that is part of a system is patched as part
// of it, towards the SYSTEM's exits (routes/systems.js), so its own list is
// read-only while it stands there — it is what the rack answers with again
// once it stands alone.
export function rackOutputRoutes(db) {
  const { RackModule, RackOutput } = db.models;
  const IN_A_SYSTEM = "this rack is part of a system — mark where sound leaves on the system's outputs";
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
    if (rack.system_id !== null) return res.status(409).json({ error: IN_A_SYSTEM });
    const moduleId = Number(req.body?.module_id) || 0;
    const mapping = await RackModule.findOne({ where: { rack_id: rack.id, module_id: moduleId } });
    if (!mapping) return res.status(400).json({ error: 'that module is not in this rack' });
    const { component, error } = await outputJack(db, moduleId, req.body?.component_id);
    if (error) return res.status(400).json({ error });
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
    if (rack.system_id !== null) return res.status(409).json({ error: IN_A_SYSTEM });
    const deleted = await RackOutput.destroy({
      where: { id: Number(req.params.outputId) || 0, rack_id: rack.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Output not found' });
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  return router;
}
