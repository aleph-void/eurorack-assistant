// Rack membership helpers. Modules are shared records mapped into per-user
// racks (rack_modules); "the user has this module" means it sits in at least
// one of their racks. Racks are strictly private to their owner.

import { Op, fn, col, where } from 'sequelize';

export const DEFAULT_RACK_NAME = 'main rack';

// The user's rack with this name (case-insensitive), or null.
export function findRackByName(db, userId, name, { transaction } = {}) {
  return db.models.Rack.findOne({
    where: {
      user_id: userId,
      [Op.and]: [where(fn('lower', col('name')), name.toLowerCase())],
    },
    transaction,
  });
}

// Find or create the user's rack with this name (case-insensitive match,
// created with the caller's casing).
export async function findOrCreateRack(db, userId, name, { transaction } = {}) {
  const existing = await findRackByName(db, userId, name, { transaction });
  if (existing) return existing;
  return db.models.Rack.create({ user_id: userId, name }, { transaction });
}

// The user's system with this name (case-insensitive), or null. Systems are
// named per user exactly as racks are.
export function findSystemByName(db, userId, name, { transaction } = {}) {
  return db.models.System.findOne({
    where: {
      user_id: userId,
      [Op.and]: [where(fn('lower', col('name')), name.toLowerCase())],
    },
    transaction,
  });
}

// ---- floor-plan geometry ----
// A rack takes up floor in the units its system coordinates are measured in:
// HP across, rack units down. This is the one place that geometry is worked
// out — the plan draws boxes with it, and the layout route refuses
// placements that would put two racks in the same place.

// What a rack nobody has organized into rows yet stands as: a plain 84 HP,
// 3U case, which is the box the plan has always drawn for it.
export const DEFAULT_RACK_HP = 84;
export const DEFAULT_RACK_U = 3;

// As wide as the rack's widest row, as tall as its rows stacked up.
export function rackFootprint(rows = []) {
  const width = rows.reduce((max, row) => Math.max(max, Number(row.hp) || 0), 0);
  const height = rows.reduce((sum, row) => sum + (Number(row.unit) || DEFAULT_RACK_U), 0);
  return { width_hp: width || DEFAULT_RACK_HP, height_u: height || DEFAULT_RACK_U };
}

// Footprints for a set of racks, off one query rather than one per rack.
export async function rackFootprints(db, rackIds) {
  const ids = [...new Set(rackIds.map(Number).filter(Number.isInteger))];
  const rows = ids.length
    ? await db.models.RackRow.findAll({
        where: { rack_id: ids },
        attributes: ['rack_id', 'unit', 'hp'],
      })
    : [];
  return new Map(
    ids.map((id) => [id, rackFootprint(rows.filter((row) => row.rack_id === id))])
  );
}

// Where a rack joining a system should stand: flush to the right of
// everything already in it, which is free floor by construction. A studio
// that has already run out of width to the right starts a new row below
// instead of standing the newcomer on top of its neighbours.
export function freePlacement(standing, footprint, { maxWidth = 5000 } = {}) {
  if (standing.length === 0) return { x: 0, y: 0 };
  const right = standing.reduce((max, rack) => Math.max(max, rack.x + rack.width_hp), 0);
  if (right + footprint.width_hp <= maxWidth) return { x: right, y: 0 };
  const bottom = standing.reduce((max, rack) => Math.max(max, rack.y + rack.height_u), 0);
  return { x: 0, y: bottom };
}

// Two placed racks overlap when their boxes share floor in BOTH directions.
// Standing flush — one rack's right edge against the next one's left — is
// how cases actually sit on a desk, so touching edges are not an overlap.
export function racksOverlap(a, b) {
  return (
    a.x < b.x + b.width_hp &&
    b.x < a.x + a.width_hp &&
    a.y < b.y + b.height_u &&
    b.y < a.y + a.height_u
  );
}

// Distinct ids of every module in any of the user's racks.
export async function userModuleIds(db, userId) {
  const { Rack, RackModule } = db.models;
  const mappings = await RackModule.findAll({
    attributes: ['module_id'],
    include: [{ model: Rack, where: { user_id: userId }, attributes: [] }],
  });
  return [...new Set(mappings.map((m) => m.module_id))];
}

// Whether the module sits in at least one of the user's racks.
export async function userHasModule(db, userId, moduleId) {
  const { Rack, RackModule } = db.models;
  const mapping = await RackModule.findOne({
    where: { module_id: Number(moduleId) },
    include: [{ model: Rack, where: { user_id: userId }, attributes: [] }],
  });
  return mapping !== null;
}
