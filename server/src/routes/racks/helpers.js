// Helpers shared by the /api/racks sub-routers. Each takes db explicitly so
// the sub-routers stay plain factory functions over it.

export function ownRack(db, userId, id) {
  const { Rack } = db.models;
  return Rack.findOne({ where: { id: Number(id), user_id: userId } });
}

// Drop a rack's physical placements of a module down to `keep` of them,
// highest positions first. rack_modules is the inventory a layout draws
// from, so a rack can never stand more copies in its rows than it holds:
// both shrinking the quantity and moving copies out come through here.
export async function trimPlacements(db, rackId, moduleId, keep, transaction) {
  const { RackRow, RackRowModule } = db.models;
  const rows = await RackRow.findAll({ where: { rack_id: rackId }, transaction });
  if (rows.length === 0) return;
  const placements = await RackRowModule.findAll({
    where: { row_id: rows.map((row) => row.id), module_id: moduleId },
    order: [
      ['position', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction,
  });
  const excess = placements.slice(0, Math.max(0, placements.length - keep));
  for (const placement of excess) await placement.destroy({ transaction });
}

// Move copies of a module out of `from` and into `to`, merging with what
// the target rack already holds. `count` is how many copies go; null moves
// the lot. The copies that leave take the source rack's physical
// placements of them with them, so what stands in its rows never exceeds

export async function moveModule(db, from, to, moduleId, transaction, count = null) {
  const { RackModule } = db.models;
  const source = await RackModule.findOne({
    where: { rack_id: from.id, module_id: moduleId },
    transaction,
  });
  if (!source) return false;
  const moving = count === null ? source.quantity : Math.min(count, source.quantity);
  if (moving < 1) return false;
  const target = await RackModule.findOne({
    where: { rack_id: to.id, module_id: moduleId },
    transaction,
  });
  if (target) {
    await target.update({ quantity: target.quantity + moving }, { transaction });
  } else {
    await RackModule.create(
      { rack_id: to.id, module_id: moduleId, quantity: moving },
      { transaction }
    );
  }
  const left = source.quantity - moving;
  if (left > 0) await source.update({ quantity: left }, { transaction });
  else await source.destroy({ transaction });
  await trimPlacements(db, from.id, moduleId, left, transaction);
  return true;
}

// The two racks a move runs between, or the response that says why not.
export async function moveEnds(db, req, res, toId) {
  if (!Number.isInteger(toId) || toId <= 0) {
    res.status(400).json({ error: 'to_rack_id is required' });
    return null;
  }
  const from = await ownRack(db, req.user.id, req.params.id);
  const to = await ownRack(db, req.user.id, toId);
  if (!from || !to) {
    res.status(404).json({ error: 'Rack not found' });
    return null;
  }
  if (from.id === to.id) {
    res.status(400).json({ error: 'to_rack_id must be a different rack' });
    return null;
  }
  return { from, to };
}
