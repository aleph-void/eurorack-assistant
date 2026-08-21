// A user's patches are told apart by name, so a name is only ever in use once
// in an account (migration 035 says the same thing in the schema). Two users
// may each have an 'Evening drone'; one user may not have two.
//
// Only LIVE patches count: a patch is really deleted when it is deleted, so
// the name a deleted patch held is free again the moment it goes.
//
// The rule is applied twice over: a name the user typed and cannot have is
// refused (409, with the name in the message), while a name the app made up
// on their behalf — a clone's '(copy)', an import's name out of the file —
// takes the next free one rather than refusing work nobody named.

const INDEX = 'patches_user_name_uniq';

export const nameTakenMessage = (name) => `you already have a patch called '${name}'`;

// The user's patch of that name, if they have one. `exceptId` leaves one
// patch out of the search, which is what lets a rename keep the name it
// already has.
export async function patchNamed(db, userId, name, { exceptId = null } = {}) {
  const { Patch } = db.models;
  const rows = await Patch.findAll({
    where: { user_id: userId, name },
    attributes: ['id', 'name'],
  });
  return rows.find((p) => p.id !== exceptId) ?? null;
}

// The first name of this shape the user does not already hold: the one asked
// for, then '<name> 2', '<name> 3' ... Always terminates — the account holds
// finitely many names.
export async function freePatchName(db, userId, wanted) {
  const { Patch } = db.models;
  const rows = await Patch.findAll({ where: { user_id: userId }, attributes: ['name'] });
  const taken = new Set(rows.map((p) => p.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Two requests can both find a name free and both go on to take it; the
// unique index catches the second. This says so, so the loser gets the same
// 409 the check above would have given rather than a 500.
export function isNameConflict(error) {
  if (error?.name !== 'SequelizeUniqueConstraintError') return false;
  const constraint = error.parent?.constraint ?? error.original?.constraint ?? '';
  if (constraint) return constraint === INDEX;
  return (error.errors ?? []).some((e) => e.path === 'name' || e.path === INDEX);
}
