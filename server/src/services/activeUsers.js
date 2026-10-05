// How many people are really using the app, and the ceiling the admin puts
// on that number.
//
// An ACTIVE user is one who has logged in within the last two weeks. An
// account that has never logged in counts for the two weeks after it is
// made — it was registered to be used, and the admin who just created it
// should see it against the limit at once rather than only once the user
// first signs in. After that an untouched account is as inactive as one
// that went quiet.
//
// `max_active_users` (app_config, 0 = no ceiling) CLOSES REGISTRATION when
// the active count has reached it: the only way an account is registered
// is the admin's Create user form (POST /api/users), and that is what is
// refused. It never shuts anybody out: a user who comes back after a quiet
// spell logs in as always, and if they take the active count past the
// ceiling the ceiling is raised to fit them (`admitReturningUser`), so the
// number the admin set is the number of people the app has, not a lock.

import { getConfig, setConfig } from './config.js';

export const ACTIVE_WINDOW_DAYS = 14;
const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function isActiveUser(user, now = Date.now()) {
  const since = now - ACTIVE_WINDOW_MS;
  const at = user?.last_login_at ? new Date(user.last_login_at).getTime() : null;
  if (at !== null && !Number.isNaN(at)) return at > since;
  const created = user?.created_at ? new Date(user.created_at).getTime() : null;
  return created !== null && !Number.isNaN(created) && created > since;
}

// Counted in JS over a flat page of the columns it needs: the rule is an OR
// of two dates, which is the predicate pg-mem drops rows under.
export async function countActiveUsers(db, { now = Date.now() } = {}) {
  const users = await db.models.User.findAll({
    attributes: ['id', 'last_login_at', 'created_at'],
  });
  return users.filter((user) => isActiveUser(user, now)).length;
}

export async function activeUserLimit(db) {
  const n = Number((await getConfig(db)).max_active_users);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// What the Users page and the create route read: the ceiling, the count
// against it, and whether another account may be made.
export async function registrationStatus(db, { now = Date.now() } = {}) {
  const [limit, active] = await Promise.all([activeUserLimit(db), countActiveUsers(db, { now })]);
  return {
    limit,
    active,
    window_days: ACTIVE_WINDOW_DAYS,
    open: limit === 0 || active < limit,
  };
}

export const REGISTRATION_CLOSED = (status) =>
  `Registration is closed: ${status.active} of ${status.limit} active users` +
  ` (anyone who logged in within the last ${status.window_days} days).` +
  ' Raise the maximum on the Configuration page to add more.';

// Called with the user as they were BEFORE this login was recorded. A user
// who was already active changes nothing; one coming back from a quiet
// spell is now one more active user, and if that is more than the ceiling
// allows the ceiling moves up to them. Returns the new limit, or null when
// nothing changed.
export async function admitReturningUser(db, userBefore, { now = Date.now() } = {}) {
  if (isActiveUser(userBefore, now)) return null;
  const limit = await activeUserLimit(db);
  if (limit === 0) return null;
  const active = await countActiveUsers(db, { now });
  if (active <= limit) return null;
  await setConfig(db, { max_active_users: active });
  return active;
}
