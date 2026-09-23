import { Router } from 'express';
import { ownRack } from './helpers.js';
import { rackOutputsJson } from '../../services/rackJson.js';
import { addOutput, outputJackIds, setOutputJacks } from '../../services/studioOutputs.js';
import { asyncHandler } from '../asyncHandler.js';

// Where sound leaves the rack: the modules that feed the speakers, the
// interface, the mixer on the desk, each with the jacks of it in use if the
// owner cares to say. A fact about the studio, so it is kept on the rack —
// module records are shared — and every patch made of the rack takes its own
// copy (services/patchCreate.js). A rack that is part of a system is patched
// as part of it, towards the SYSTEM's exits (routes/systems.js), so its own
// list is read-only while it stands there — it is what the rack answers with
// again once it stands alone.
export function rackOutputRoutes(db) {
  const { RackModule, RackOutput, RackOutputJack } = db.models;
  const router = Router();
  const IN_A_SYSTEM = "this rack is part of a system — mark where sound leaves on the system's outputs";

  // The rack, if it is this user's and may be edited: answers the rack or
  // sends the refusal and answers null.
  const editableRack = async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) {
      res.status(404).json({ error: 'Rack not found' });
      return null;
    }
    if (rack.system_id !== null) {
      res.status(409).json({ error: IN_A_SYSTEM });
      return null;
    }
    return rack;
  };

  const ownOutput = (rack, outputId) =>
    RackOutput.findOne({ where: { id: Number(outputId) || 0, rack_id: rack.id } });

  router.get('/:id/outputs', asyncHandler(async (req, res) => {
    const rack = await ownRack(db, req.user.id, req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  // Body: { module_id, component_ids? } — a module the rack holds, and the
  // jacks of it in use (none: the module as a whole).
  router.post('/:id/outputs', asyncHandler(async (req, res) => {
    const rack = await editableRack(req, res);
    if (!rack) return;
    const moduleId = Number(req.body?.module_id) || 0;
    const mapping = await RackModule.findOne({ where: { rack_id: rack.id, module_id: moduleId } });
    if (!mapping) return res.status(400).json({ error: 'that module is not in this rack' });
    const { ids, error } = await outputJackIds(db, moduleId, req.body?.component_ids);
    if (error) return res.status(400).json({ error });
    const created = await addOutput(
      db,
      RackOutput,
      RackOutputJack,
      { rack_id: rack.id, module_id: moduleId },
      { rack_id: rack.id },
      ids
    );
    if (!created) return res.status(409).json({ error: 'that module is already one of this rack\'s outputs' });
    res.status(201).json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  // Body: { component_ids } — which of the module's jacks are in use, all of
  // them at once; an empty list is the module as a whole.
  router.put('/:id/outputs/:outputId', asyncHandler(async (req, res) => {
    const rack = await editableRack(req, res);
    if (!rack) return;
    const output = await ownOutput(rack, req.params.outputId);
    if (!output) return res.status(404).json({ error: 'Output not found' });
    const { ids, error } = await outputJackIds(db, output.module_id, req.body?.component_ids ?? []);
    if (error) return res.status(400).json({ error });
    await db.sequelize.transaction((transaction) =>
      setOutputJacks(RackOutputJack, output.id, ids, { transaction })
    );
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  router.delete('/:id/outputs/:outputId', asyncHandler(async (req, res) => {
    const rack = await editableRack(req, res);
    if (!rack) return;
    const output = await ownOutput(rack, req.params.outputId);
    if (!output) return res.status(404).json({ error: 'Output not found' });
    await output.destroy();
    res.json({ outputs: await rackOutputsJson(db, rack.id) });
  }));

  return router;
}
