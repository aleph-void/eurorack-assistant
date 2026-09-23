// Where sound leaves a rack or a system: the MODULES marked as exits (an
// output module, the mixer on the desk, the interface's input panel), each
// with the jacks of it in use — none at all is an answer, the module as a
// whole. The rack and the system keep the same two tables each
// (rack_outputs + rack_output_jacks, system_outputs + system_output_jacks,
// migration 048) and are edited the same way, so the writing lives here and
// both routers call it. The shapes they answer with are services/rackJson.js.

// The most jacks one output may name: a module has only so many.
export const MAX_OUTPUT_JACKS = 64;

// The jacks sound can arrive at: an input, or a jack that is either. An output
// jack cannot be an exit — nothing is patched INTO it (an interface's outputs
// send the computer's audio back into the rack; its inputs are the channels
// the rack is recorded on).
export const EXIT_JACK_TYPES = ['input_jack', 'bidirectional_jack'];
export const EXIT_JACK_ERROR = 'an output has to be an input or bidirectional jack — sound leaves by a cable into it';

// The jacks a request names for a module's output, checked: each has to be an
// input (or bidirectional) jack of that module, because sound leaves through a
// cable into it. Nothing named is the module as a whole. Answers { ids } or
// { error } (a 400's message).
export async function outputJackIds(db, moduleId, raw) {
  if (raw === undefined || raw === null) return { ids: [] };
  if (!Array.isArray(raw)) return { error: 'component_ids must be a list of jacks' };
  if (raw.length > MAX_OUTPUT_JACKS) return { error: `an output names at most ${MAX_OUTPUT_JACKS} jacks` };
  const ids = [...new Set(raw.map((id) => Number(id) || 0))];
  if (ids.length === 0) return { ids };
  const found = await db.models.ModuleComponent.findAll({
    where: { id: ids, module_id: moduleId },
    attributes: ['id', 'type'],
  });
  if (found.length !== ids.length) return { error: 'that component does not belong to this module' };
  if (found.some((c) => !EXIT_JACK_TYPES.includes(c.type))) return { error: EXIT_JACK_ERROR };
  return { ids };
}

// Replace the jacks under one output with `ids`, in that order.
export async function setOutputJacks(Jack, outputId, ids, { transaction } = {}) {
  await Jack.destroy({ where: { output_id: outputId }, transaction });
  if (ids.length > 0) {
    await Jack.bulkCreate(
      ids.map((componentId, at) => ({ output_id: outputId, component_id: componentId, position: at + 1 })),
      { transaction }
    );
  }
}

// Mark a module as an output: `where` names the owner and the module (with
// the rack, for a system), and it goes after the ones already marked. Answers
// the new row, or null when that module is already one.
export async function addOutput(db, Output, Jack, where, ownerWhere, ids) {
  if (await Output.findOne({ where })) return null;
  const last = await Output.max('position', { where: ownerWhere });
  let output;
  await db.sequelize.transaction(async (transaction) => {
    output = await Output.create({ ...where, position: (Number(last) || 0) + 1 }, { transaction });
    await setOutputJacks(Jack, output.id, ids, { transaction });
  });
  return output;
}

// Every output with its jack ids, in order — what a new patch copies and
// what a rack brings into a system.
export async function loadOutputs(Output, Jack, where) {
  const outputs = await Output.findAll({
    where,
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const jacks =
    outputs.length === 0
      ? []
      : await Jack.findAll({
          where: { output_id: outputs.map((o) => o.id) },
          order: [
            ['position', 'ASC'],
            ['id', 'ASC'],
          ],
        });
  return outputs.map((o) => ({
    rack_id: o.rack_id,
    module_id: o.module_id,
    component_ids: jacks.filter((j) => j.output_id === o.id).map((j) => j.component_id),
  }));
}

// A rack joining a system brings the exits marked on it, so a case that was
// patched towards its own output module keeps that exit in the studio. A
// module the system already has marked in that rack is left as it is.
export async function carryRackOutputs(db, rack, systemId) {
  const { RackOutput, RackOutputJack, SystemOutput, SystemOutputJack } = db.models;
  const marked = await loadOutputs(RackOutput, RackOutputJack, { rack_id: rack.id });
  for (const o of marked) {
    await addOutput(
      db,
      SystemOutput,
      SystemOutputJack,
      { system_id: systemId, rack_id: rack.id, module_id: o.module_id },
      { system_id: systemId },
      o.component_ids
    );
  }
}
