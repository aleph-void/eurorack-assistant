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
