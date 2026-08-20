// The physical arrangement a patch carries with it.
//
// Modules are organised in one place — the rack (rack_rows /
// rack_row_modules, the Organize rack page). A patch takes a COPY of that
// arrangement when it is created and draws from the copy ever after, so
// rebuilding a case does not rearrange the diagram of every patch ever made
// from it. Catching a patch up with its rack is an explicit act (resync).
//
// The copy is soft all the way through, like the rest of a patch snapshot:
// it names racks and modules by id and by name, and nothing here assumes
// either still exists.

// The racks a patch was built from: the ones its instances were snapshotted
// from (a system patch spans several), falling back to the patch's own rack
// for patches made before instances carried one.
export function patchRackIds(patch, patchModules) {
  const fromInstances = [
    ...new Set(patchModules.map((pm) => pm.rack_id).filter((id) => id !== null && id !== undefined)),
  ];
  if (fromInstances.length > 0) return fromInstances;
  return patch.rack_id ? [patch.rack_id] : [];
}

// Copy the rows of these racks into the patch, replacing whatever it holds.
// The racks are re-checked against the patch's owner by the caller — these
// are soft ids, and a patch may not read another account's furniture.
export async function snapshotRackLayout(db, patch, racks, { transaction = null } = {}) {
  const { RackRow, RackRowModule, PatchRackRow, PatchRackRowModule } = db.models;
  await PatchRackRow.destroy({ where: { patch_id: patch.id }, transaction });
  if (racks.length === 0) return 0;
  const rows = await RackRow.findAll({
    where: { rack_id: racks.map((rack) => rack.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  if (rows.length === 0) return 0;
  const placements = await RackRowModule.findAll({
    where: { row_id: rows.map((row) => row.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  let written = 0;
  for (const rack of racks) {
    for (const row of rows.filter((r) => r.rack_id === rack.id)) {
      const copy = await PatchRackRow.create(
        {
          patch_id: patch.id,
          rack_id: rack.id,
          rack_name: rack.name,
          rack_position: rack.system_position ?? 0,
          unit: row.unit,
          hp: row.hp,
          position: row.position,
        },
        { transaction }
      );
      written += 1;
      const placed = placements.filter((placement) => placement.row_id === row.id);
      if (placed.length === 0) continue;
      await PatchRackRowModule.bulkCreate(
        placed.map((placement) => ({
          row_id: copy.id,
          module_id: placement.module_id,
          position: placement.position,
        })),
        { transaction }
      );
    }
  }
  return written;
}

// The racks the patch stands in, as they are now, if the owner still has
// them. Used both when a patch is created and when one is told to catch up.
export async function currentRacksOfPatch(db, patch, patchModules, { transaction = null } = {}) {
  const ids = patchRackIds(patch, patchModules);
  if (ids.length === 0) return [];
  return db.models.Rack.findAll({
    where: { id: ids, user_id: patch.user_id },
    order: [
      ['system_position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
}

// Take a fresh copy of the racks this patch stands in — the resync.
export async function resyncRackLayout(db, patch) {
  const patchModules = await db.models.PatchModule.findAll({
    where: { patch_id: patch.id },
    attributes: ['rack_id'],
  });
  const racks = await currentRacksOfPatch(db, patch, patchModules);
  return db.sequelize.transaction((transaction) =>
    snapshotRackLayout(db, patch, racks, { transaction })
  );
}

// Copy one patch's arrangement onto another — what cloning a patch does.
// The clone is a copy of the patch, not a fresh look at the studio.
export async function copyRackLayout(db, sourcePatchId, patch, { transaction = null } = {}) {
  const { PatchRackRow, PatchRackRowModule } = db.models;
  const rows = await PatchRackRow.findAll({
    where: { patch_id: sourcePatchId },
    order: [['id', 'ASC']],
    transaction,
  });
  if (rows.length === 0) return 0;
  const placements = await PatchRackRowModule.findAll({
    where: { row_id: rows.map((row) => row.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  for (const row of rows) {
    const copy = await PatchRackRow.create(
      {
        patch_id: patch.id,
        rack_id: row.rack_id,
        rack_name: row.rack_name,
        rack_position: row.rack_position,
        unit: row.unit,
        hp: row.hp,
        position: row.position,
      },
      { transaction }
    );
    const placed = placements.filter((placement) => placement.row_id === row.id);
    if (placed.length === 0) continue;
    await PatchRackRowModule.bulkCreate(
      placed.map((placement) => ({
        row_id: copy.id,
        module_id: placement.module_id,
        position: placement.position,
      })),
      { transaction }
    );
  }
  return rows.length;
}

// The rows a patch snapshotted, in the order the studio reads: rack by rack
// as they stood in the system, each rack's own rows top to bottom.
export async function loadPatchRackLayout(db, patchId) {
  const { PatchRackRow, PatchRackRowModule } = db.models;
  const rows = await PatchRackRow.findAll({
    where: { patch_id: patchId },
    order: [
      ['rack_position', 'ASC'],
      ['rack_id', 'ASC'],
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (rows.length === 0) return { rows: [], placements: [] };
  const placements = await PatchRackRowModule.findAll({
    where: { row_id: rows.map((row) => row.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return { rows, placements };
}
