// Performances: what one is allowed to say, who may do what to it, and how it
// serializes.
//
// A performance is a video somebody already published, shown here to every
// account so the people who know the hardware can watch it and talk about
// it. That inverts the app's usual rule — everything else a user makes is
// private until shared — so the permissions are worth stating in one place:
//
//   - every signed-in user READS every performance and its comments, and may
//     leave a comment of their own; a performance its author marked PUBLIC
//     is read by anyone with the link, signed in or not, patch included —
//     but a visitor without an account leaves no comment, because a word
//     under somebody's performance has to be somebody's word;
//   - the AUTHOR alone edits the performance — its title, its text, the video,
//     which of their patches is shown and which modules are listed — and the
//     author or an admin deletes it;
//   - a comment goes at the hand of the one who wrote it, the author of the
//     performance it is on, or an admin.
//
// Nothing here fetches the video. The pasted link is reduced to the eleven
// characters that name it (services/videos.js, the same parser a module's
// tutorial videos go through) and the canonical URL is rebuilt from those; a
// link that is not a YouTube video is refused rather than guessed at.

import { Op } from 'sequelize';
import { parseYoutubeId, youtubeUrl } from './videos.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_COMMENT_LENGTH = 5000;
// More modules than a studio has rows of HP is a list nobody typed.
export const MAX_MODULES = 200;

export const text = (value, max) => {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

// The video a pasted link names: { video_id, url } or { error }.
export function readVideo(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { error: 'A performance needs the link to its video' };
  // A bare host the way people paste one, before the parser insists on a
  // scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const videoId = parseYoutubeId(candidate);
  if (!videoId) return { error: 'That is not a link to a YouTube video' };
  return { video_id: videoId, url: youtubeUrl(videoId) };
}

// A list of module ids the author says were used — whole numbers, each once,
// each a module in one of the AUTHOR's racks. A module record is shared
// between everyone who racked it, so "yours to list" means you racked it,
// the same test a link on a module meets (services/resourceLinks.js).
export async function readModuleIds(db, userId, value) {
  if (value === undefined) return { skip: true };
  if (!Array.isArray(value)) return { error: 'module_ids must be a list of module ids' };
  const ids = [];
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return { error: 'module_ids must be a list of module ids' };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_MODULES) return { error: `A performance lists at most ${MAX_MODULES} modules` };
  const racked = await rackedModuleIds(db, userId, ids);
  const missing = ids.find((id) => !racked.has(id));
  if (missing !== undefined) return { error: `Module ${missing} is not in any of your racks` };
  return { ids };
}

// Which of these modules a user has in a rack of theirs, as a Set of ids.
export async function rackedModuleIds(db, userId, moduleIds) {
  if (!userId || moduleIds.length === 0) return new Set();
  const { Rack, RackModule } = db.models;
  const rows = await RackModule.findAll({
    where: { module_id: moduleIds },
    include: [{ model: Rack, where: { user_id: userId }, attributes: [] }],
    attributes: ['module_id'],
  });
  return new Set(rows.map((row) => row.module_id));
}

// The patch to show beside the video: one of the author's own, or null to
// show none. `skip` when the request said nothing about it.
export async function readPatch(db, userId, value) {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { patch: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: 'patch_id must be a patch id' };
  const patch = await db.models.Patch.findOne({ where: { id, user_id: userId } });
  if (!patch) return { error: 'That patch is not one of yours' };
  return { patch };
}

// Replace the module list of one performance with these ids, in this order.
export async function replaceModules(db, performanceId, ids, { transaction = null } = {}) {
  const { PerformanceModule } = db.models;
  await PerformanceModule.destroy({ where: { performance_id: performanceId }, transaction });
  for (const [position, moduleId] of ids.entries()) {
    await PerformanceModule.create(
      { performance_id: performanceId, module_id: moduleId, position },
      { transaction }
    );
  }
}

// Who may read a performance at all: any account, or anyone when it is public.
export const canReadPerformance = (performance, user) =>
  Boolean(user) || Boolean(performance.public);

// Who may take a comment down: its writer, the performance's author, an admin.
export const canRemoveComment = (comment, performance, user) =>
  Boolean(user) &&
  (comment.user_id === user.id || performance.user_id === user.id || Boolean(user.is_admin));

// Who may delete or edit the performance itself. Editing is the author's
// alone; deleting is also the admin's, who is answerable for what the whole
// room shows.
export const canEditPerformance = (performance, user) =>
  Boolean(user) && performance.user_id === user.id;
export const canDeletePerformance = (performance, user) =>
  Boolean(user) && (performance.user_id === user.id || Boolean(user.is_admin));

// The patch as the page names it: live (readable through the performance),
// gone (its name remains), or none.
const patchRef = (row) => {
  if (row.patch_id) return { id: row.patch_id, name: row.patch_name, live: true };
  if (row.patch_name) return { id: null, name: row.patch_name, live: false };
  return null;
};

// Everything a /api/performances response says about one goes through this,
// so a performance serializes identically on the list and the page.
export const performanceJson = (row, { viewer = null, owner_username = null, ...extra } = {}) => {
  const plain = row.get ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    user_id: plain.user_id,
    owner_username,
    title: plain.title,
    description: plain.description,
    url: plain.url,
    video_id: plain.video_id,
    public: Boolean(plain.public),
    patch: patchRef(plain),
    mine: Boolean(viewer) && plain.user_id === viewer.id,
    can_delete: canDeletePerformance(plain, viewer),
    created_at: plain.created_at,
    updated_at: plain.updated_at,
    ...extra,
  };
};

export const commentJson = (row, { username = null, performance, viewer = null }) => {
  const plain = row.get ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    performance_id: plain.performance_id,
    user_id: plain.user_id,
    username,
    body: plain.body,
    mine: Boolean(viewer) && plain.user_id === viewer.id,
    can_delete: canRemoveComment(plain, performance, viewer),
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
};

// The modules listed on one performance, in the author's order, each marked
// with whether the VIEWER has it too — a module the viewer racked is a page
// they can open; one they have not is a name.
export async function performanceModules(db, performanceId, viewerId) {
  const { PerformanceModule, Module } = db.models;
  const rows = await PerformanceModule.findAll({
    where: { performance_id: performanceId },
    include: [Module],
    order: [
      ['position', 'ASC'],
      ['module_id', 'ASC'],
    ],
  });
  const yours = await rackedModuleIds(
    db,
    viewerId,
    rows.map((row) => row.module_id)
  );
  return rows
    .filter((row) => row.Module)
    .map((row) => ({
      id: row.module_id,
      manufacturer: row.Module.manufacturer,
      name: row.Module.name,
      hp: row.Module.hp,
      summary: row.Module.summary,
      yours: yours.has(row.module_id),
    }));
}

const usernamesFor = async (db, ids) => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await db.models.User.findAll({
    where: { id: unique },
    attributes: ['id', 'username'],
  });
  return new Map(users.map((u) => [u.id, u.username]));
};

// The comments under one performance, oldest first: a conversation reads
// downwards.
export async function performanceComments(db, performance, viewer) {
  const rows = await db.models.PerformanceComment.findAll({
    where: { performance_id: performance.id },
    order: [['id', 'ASC']],
  });
  const names = await usernamesFor(
    db,
    rows.map((row) => row.user_id)
  );
  return rows.map((row) =>
    commentJson(row, { username: names.get(row.user_id) ?? null, performance, viewer })
  );
}

// The whole page: the performance, who made it, the modules, the comments.
export async function loadPerformance(db, performance, viewer) {
  const [names, modules, comments] = await Promise.all([
    usernamesFor(db, [performance.user_id]),
    performanceModules(db, performance.id, viewer?.id),
    performanceComments(db, performance, viewer),
  ]);
  return performanceJson(performance, {
    viewer,
    owner_username: names.get(performance.user_id) ?? null,
    modules,
    comments,
    module_count: modules.length,
    comment_count: comments.length,
  });
}

// One page of the list, newest first, with the counts a row shows.
export async function listPerformances(db, viewer, { limit, before, mine = false }) {
  const { Performance, PerformanceModule, PerformanceComment } = db.models;
  const where = {};
  if (mine) where.user_id = viewer.id;
  const total = await Performance.count({ where });
  // Paged by id, like the job and patch lists: a performance shared while
  // the list is read lands above the first page rather than shifting an
  // offset window. One more row than the page says whether there is another.
  const rows = await Performance.findAll({
    where: before ? { ...where, id: { [Op.lt]: before } } : where,
    order: [['id', 'DESC']],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const [moduleRows, commentRows, names] = await Promise.all([
    ids.length
      ? PerformanceModule.findAll({ where: { performance_id: ids }, attributes: ['performance_id'] })
      : [],
    ids.length
      ? PerformanceComment.findAll({ where: { performance_id: ids }, attributes: ['performance_id'] })
      : [],
    usernamesFor(
      db,
      page.map((row) => row.user_id)
    ),
  ]);
  const tally = (list) => {
    const map = new Map();
    for (const row of list) {
      map.set(row.performance_id, (map.get(row.performance_id) ?? 0) + 1);
    }
    return map;
  };
  const moduleCounts = tally(moduleRows);
  const commentCounts = tally(commentRows);
  return {
    total,
    limit,
    has_more: hasMore,
    next_before: hasMore ? page[page.length - 1].id : null,
    performances: page.map((row) =>
      performanceJson(row, {
        viewer,
        owner_username: names.get(row.user_id) ?? null,
        module_count: moduleCounts.get(row.id) ?? 0,
        comment_count: commentCounts.get(row.id) ?? 0,
      })
    ),
  };
}
