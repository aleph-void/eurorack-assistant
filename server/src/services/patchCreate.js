// Making a patch out of a rack or a system: the snapshot every patch starts
// as. `POST /api/patches` and `POST /api/patches/generate` both begin here —
// one hands the empty patch to the user, the other to the model — and there
// must be exactly one answer to "what does a new patch of this system hold".

import { inFloorOrder, snapshotRackLayout } from './patchLayout.js';
import { materializeBridges } from './moduleBridges.js';

// Which racks a request wants a patch of, from a body naming either a
// system (every rack in it at once) or a single rack. Answers
// { system, racks, mappings } — the rack_modules rows of those racks, each
// with its Module — or { status, error } when the request cannot be served.
export async function loadPatchSource(db, userId, body) {
  const { System, Rack, RackModule, Module } = db.models;
  const wantsSystem =
    body?.system_id !== undefined && body?.system_id !== null && body?.system_id !== '';
  let system = null;
  let racks;
  if (wantsSystem) {
    system = await System.findOne({
      where: { id: Number(body.system_id) || 0, user_id: userId },
    });
    if (!system) return { status: 404, error: 'System not found' };
    // In the order the studio reads — how the racks stand on the system's
    // floor plan — so the instances of a system patch are numbered, and its
    // panels drawn, the way the racks are actually arranged.
    racks = inFloorOrder(
      await Rack.findAll({ where: { system_id: system.id }, order: [['id', 'ASC']] })
    );
    if (racks.length === 0) {
      return { status: 400, error: 'this system has no racks to patch' };
    }
  } else {
    const rack = await Rack.findOne({
      where: { id: Number(body?.rack_id) || 0, user_id: userId },
    });
    if (!rack) return { status: 404, error: 'Rack not found' };
    racks = [rack];
  }
  const mappings = await RackModule.findAll({
    where: { rack_id: racks.map((rack) => rack.id) },
    include: [Module],
    order: [
      [Module, 'manufacturer', 'ASC'],
      [Module, 'name', 'ASC'],
    ],
  });
  if (mappings.length === 0) {
    return {
      status: 400,
      error: system ? 'this system has no modules to patch' : 'this rack has no modules to patch',
    };
  }
  return { system, racks, mappings };
}

// Create the patch: one patch_modules row per module INSTANCE (quantity 2
// becomes instance 1 and instance 2 so cables can tell them apart — across a
// system the numbering keeps running, so the same module in two racks still
// gets distinct instance numbers, and the rack columns say which copy stands
// where), the patch's own copy of the racks' arrangement, and the links that
// arrive already wired: hosts to their expanders, and the two panels of a
// dual module. Runs in its own transaction; a name conflict surfaces as the
// unique-index error the caller's `takingName` recognises.
//
// Answers { patch, moduleCount }.
export async function snapshotPatch(
  db,
  { userId, system, racks, mappings, name, description = null }
) {
  const { ModuleExpander, Patch, PatchModule, PatchModuleLink } = db.models;
  const rackById = new Map(racks.map((rack) => [rack.id, rack]));
  const instanceCounts = new Map();
  const snapshot = mappings.flatMap((rm) => {
    const rack = rackById.get(rm.rack_id);
    return Array.from({ length: Math.max(1, rm.quantity) }, () => {
      const instance = (instanceCounts.get(rm.Module.id) ?? 0) + 1;
      instanceCounts.set(rm.Module.id, instance);
      return {
        module_id: rm.Module.id,
        manufacturer: rm.Module.manufacturer,
        module_name: rm.Module.name,
        instance,
        rack_id: rack?.id ?? null,
        rack_name: rack?.name ?? null,
      };
    });
  });
  // Hosts and expanders in the same rack arrive already wired together —
  // that is what the ribbon cable does — so the patch links them without
  // being asked, instance by instance.
  const rackModuleIds = [...new Set(snapshot.map((s) => s.module_id))];
  const expanderPairs = await ModuleExpander.findAll({
    where: {
      host_module_id: rackModuleIds,
      expander_module_id: rackModuleIds,
    },
  });
  let patch;
  await db.sequelize.transaction(async (transaction) => {
    patch = await Patch.create(
      {
        user_id: userId,
        // A system patch is not filed under any one rack; rack_name is
        // NOT NULL and reads as the thing the patch was built from, so
        // the system's name stands in it as well as in system_name.
        rack_id: system ? null : racks[0].id,
        rack_name: system ? system.name : racks[0].name,
        system_id: system?.id ?? null,
        system_name: system?.name ?? null,
        name,
        description: description || null,
      },
      { transaction }
    );
    await PatchModule.bulkCreate(
      snapshot.map((m) => ({ ...m, patch_id: patch.id })),
      { transaction }
    );
    const created = await PatchModule.findAll({
      where: { patch_id: patch.id },
      order: [['id', 'ASC']],
      transaction,
    });
    // The patch takes its own copy of how these racks are laid out right
    // now, so the diagram keeps drawing the studio as it stood today
    // however the cases are rebuilt afterwards.
    await snapshotRackLayout(db, patch, racks, { transaction });
    const instancesOf = (moduleId) => created.filter((pm) => pm.module_id === moduleId);
    const linkRows = [];
    for (const pair of expanderPairs) {
      const hosts = instancesOf(pair.host_module_id);
      const expanders = instancesOf(pair.expander_module_id);
      // Pair them off in order; a spare panel on either side is left
      // unlinked for the user to wire up by hand.
      for (let i = 0; i < Math.min(hosts.length, expanders.length); i += 1) {
        linkRows.push({
          patch_id: patch.id,
          a_patch_module_id: hosts[i].id,
          b_patch_module_id: expanders[i].id,
          kind: 'expander',
        });
      }
    }
    if (linkRows.length > 0) await PatchModuleLink.bulkCreate(linkRows, { transaction });
    // Dual modules arrive wired together too — their link cable is already
    // plugged in, jack for jack, so the patch records the pair without
    // being asked (services/moduleBridges.js).
    await materializeBridges(db, patch, { transaction });
  });
  return { patch, moduleCount: snapshot.length };
}
