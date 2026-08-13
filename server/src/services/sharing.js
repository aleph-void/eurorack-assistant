// Who may read what. Every record a user makes is theirs alone until they say
// otherwise; a share says "this one of mine may be read by that user", or by
// everyone. Sharing never grants writing — the owner stays the only one who
// can change or delete what they made — so the whole of the permission
// question is answered by the two predicates at the bottom of this file:
// canRead (one record) and readableIds (a list).
//
// Five kinds of record can be shared. They have almost nothing in common
// except an owner column, so they are described here as data and the routes
// handle them uniformly rather than each growing its own sharing code.

// A document is one row in `manuals` — an upload of the owner's. The shared
// auto-found manual (user_id NULL) is not shareable because it is already
// readable by everyone, which is also why 'document' owns by user_id while the
// rest own by the same column under a different name.
export const SHAREABLE = {
  note: {
    model: 'Note',
    label: (row) => row.title || 'Untitled note',
    plural: 'notes',
  },
  patch: {
    model: 'Patch',
    label: (row) => row.name,
    plural: 'patches',
    details: (row) => ({ rack_name: row.rack_name }),
  },
  question: {
    model: 'Question',
    label: (row) => row.prompt,
    plural: 'questions',
    details: (row) => ({ status: row.status }),
  },
  rack: {
    model: 'Rack',
    label: (row) => row.name,
    plural: 'racks',
  },
  document: {
    model: 'Manual',
    label: (row) => row.name,
    plural: 'documents',
    // Only uploads have an owner, so matching on user_id is also what keeps
    // the shared auto-found manual (user_id NULL) out of anyone's hands.
    ownedWhere: (userId) => ({ user_id: userId }),
    // A document is read at its content hash, not at its record id, so the
    // listing carries the hash the reader will actually follow.
    details: (row) => ({ hash: row.hash, module_id: row.module_id }),
  },
};

export const SHAREABLE_TYPES = Object.keys(SHAREABLE);

export const isShareableType = (type) =>
  Object.prototype.hasOwnProperty.call(SHAREABLE, String(type));

// The record, if this user owns it. Everything else in this file assumes the
// caller established ownership first, because a share you do not own is not
// yours to hand out.
export async function ownedResource(db, userId, type, id) {
  if (!isShareableType(type)) return null;
  const spec = SHAREABLE[type];
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const where = spec.ownedWhere ? spec.ownedWhere(userId) : { user_id: userId };
  return db.models[spec.model].findOne({ where: { id: numeric, ...where } });
}

// Several records of one type at once, keyed by id — the listings need the
// label and the owner of a whole page of shares without a query each.
async function resourcesById(db, type, ids) {
  if (ids.length === 0) return new Map();
  const rows = await db.models[SHAREABLE[type].model].findAll({
    where: { id: [...new Set(ids)] },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

// Who this record is currently shared with: { everyone, users: [...] }.
export async function listShares(db, type, id) {
  const rows = await db.models.Share.findAll({
    where: { resource_type: type, resource_id: Number(id) },
    include: [{ model: db.models.User, as: 'Recipient' }],
    order: [['id', 'ASC']],
  });
  return {
    everyone: rows.some((row) => row.user_id === null),
    users: rows
      .filter((row) => row.user_id !== null)
      .map((row) => ({ id: row.user_id, username: row.Recipient?.username ?? null })),
  };
}

// Replace the recipient list of one record in a single transaction: the whole
// point of the share dialog is that what you see when you press Save is what
// the record is shared with afterwards, which a series of add/remove calls
// could not promise.
//
// `everyone` and a list of users are not exclusive — a record shared with
// everyone can still name individuals, and it keeps naming them so that
// turning "everyone" back off leaves those people where they were.
export async function setShares(db, { ownerId, type, id, everyone = false, userIds = [] }) {
  const { Share, User } = db.models;
  const resourceId = Number(id);

  // Recipients are checked against the user table (and the owner dropped: a
  // share with yourself is a no-op that would show up as a stranger's name in
  // your own "shared with me").
  const wanted = [...new Set(userIds.map(Number).filter(Number.isInteger))].filter(
    (userId) => userId !== ownerId
  );
  const known = wanted.length
    ? await User.findAll({ where: { id: wanted }, attributes: ['id'] })
    : [];
  const knownIds = new Set(known.map((u) => u.id));
  const missing = wanted.filter((userId) => !knownIds.has(userId));
  if (missing.length) return { error: `unknown user id ${missing[0]}` };

  await db.sequelize.transaction(async (transaction) => {
    const existing = await Share.findAll({
      where: { resource_type: type, resource_id: resourceId },
      transaction,
    });
    const keep = new Set(wanted);
    for (const row of existing) {
      const stays = row.user_id === null ? everyone : keep.has(row.user_id);
      if (stays) keep.delete(row.user_id);
      else await row.destroy({ transaction });
    }
    const hadEveryone = existing.some((row) => row.user_id === null);
    if (everyone && !hadEveryone) {
      await Share.create(
        { resource_type: type, resource_id: resourceId, owner_id: ownerId, user_id: null },
        { transaction }
      );
    }
    for (const userId of keep) {
      await Share.create(
        { resource_type: type, resource_id: resourceId, owner_id: ownerId, user_id: userId },
        { transaction }
      );
    }
  });
  return { ok: true };
}

// Called by the delete paths. A share that outlived its record grants nothing
// (ids are never reused), but it would sit in the owner's "shared by you" list
// pointing at nothing.
export function removeShares(db, type, id, { transaction = null } = {}) {
  return db.models.Share.destroy({
    where: { resource_type: type, resource_id: Number(id) },
    transaction,
  });
}

// Every share this user receives, of one type. Written as two queries rather
// than one OR because pg-mem — the test database — drops rows when an OR is
// ANDed with anything else (see tests/helpers.js), and both halves are indexed
// in the real one anyway.
async function incomingRows(db, userId, type) {
  const { Share } = db.models;
  const [mine, everyone] = await Promise.all([
    Share.findAll({ where: { resource_type: type, user_id: userId } }),
    Share.findAll({ where: { resource_type: type, user_id: null } }),
  ]);
  // Your own records reach you by owning them, not by a share you happen to
  // have addressed to everyone.
  return [...mine, ...everyone].filter((row) => row.owner_id !== userId);
}

// The ids of one type of record this user may read but does not own.
export async function readableIds(db, userId, type) {
  const rows = await incomingRows(db, userId, type);
  return [...new Set(rows.map((row) => row.resource_id))];
}

// Whether this user may read one record they do not own.
export async function canRead(db, userId, type, id) {
  const resourceId = Number(id);
  if (!isShareableType(type) || !Number.isInteger(resourceId)) return false;
  const rows = await incomingRows(db, userId, type);
  return rows.some((row) => row.resource_id === resourceId);
}

// The record itself when this user may read it: theirs, or shared with them.
// Returns { row, shared, owner_id } so a route can serve the same JSON either
// way and mark the copy that is not yours.
export async function readableResource(db, userId, type, id) {
  const own = await ownedResource(db, userId, type, id);
  if (own) return { row: own, shared: false, owner_id: userId };
  if (!(await canRead(db, userId, type, id))) return null;
  const spec = SHAREABLE[type];
  const row = await db.models[spec.model].findByPk(Number(id));
  if (!row) return null;
  return { row, shared: true, owner_id: row.user_id ?? null };
}

// One entry of a listing: enough to show a line and follow a link, without the
// record's contents.
const shareJson = (type, row, resource, username) => ({
  type,
  id: row.resource_id,
  label: SHAREABLE[type].label(resource),
  ...(SHAREABLE[type].details?.(resource) ?? {}),
  owner_id: row.owner_id,
  owner_username: username ?? null,
  shared_at: row.created_at,
});

// Everything shared WITH this user, grouped by type. Records that have been
// deleted since are skipped rather than shown as blanks.
export async function incomingShares(db, userId) {
  const { User } = db.models;
  const out = {};
  const ownerIds = new Set();
  const perType = {};
  for (const type of SHAREABLE_TYPES) {
    const rows = await incomingRows(db, userId, type);
    // A record shared with you individually AND with everyone is one entry.
    const seen = new Set();
    const unique = rows.filter((row) => {
      if (seen.has(row.resource_id)) return false;
      seen.add(row.resource_id);
      return true;
    });
    perType[type] = {
      rows: unique,
      resources: await resourcesById(db, type, unique.map((row) => row.resource_id)),
    };
    for (const row of unique) ownerIds.add(row.owner_id);
  }
  const owners = ownerIds.size
    ? await User.findAll({ where: { id: [...ownerIds] }, attributes: ['id', 'username'] })
    : [];
  const usernames = new Map(owners.map((u) => [u.id, u.username]));
  for (const type of SHAREABLE_TYPES) {
    const { rows, resources } = perType[type];
    out[SHAREABLE[type].plural] = rows
      .filter((row) => resources.has(row.resource_id))
      .map((row) =>
        shareJson(type, row, resources.get(row.resource_id), usernames.get(row.owner_id))
      )
      .sort((a, b) => b.id - a.id);
  }
  return out;
}

// Everything this user shares OUT, grouped by type, each with who can see it —
// the list a person checks before showing someone their screen.
export async function outgoingShares(db, userId) {
  const { Share, User } = db.models;
  const rows = await Share.findAll({
    where: { owner_id: userId },
    include: [{ model: User, as: 'Recipient' }],
    order: [['id', 'ASC']],
  });
  const out = {};
  for (const type of SHAREABLE_TYPES) {
    const ofType = rows.filter((row) => row.resource_type === type);
    const resources = await resourcesById(db, type, ofType.map((row) => row.resource_id));
    const byResource = new Map();
    for (const row of ofType) {
      const resource = resources.get(row.resource_id);
      if (!resource) continue;
      if (!byResource.has(row.resource_id)) {
        byResource.set(row.resource_id, {
          type,
          id: row.resource_id,
          label: SHAREABLE[type].label(resource),
          ...(SHAREABLE[type].details?.(resource) ?? {}),
          everyone: false,
          users: [],
        });
      }
      const entry = byResource.get(row.resource_id);
      if (row.user_id === null) entry.everyone = true;
      else entry.users.push({ id: row.user_id, username: row.Recipient?.username ?? null });
    }
    out[SHAREABLE[type].plural] = [...byResource.values()].sort((a, b) => b.id - a.id);
  }
  return out;
}
