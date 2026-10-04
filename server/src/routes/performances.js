// Performances: a video of someone playing their system, shown to everyone
// with an account, with the modules it was played on, optionally the patch,
// and a conversation underneath.
//
// The one place the app's "private until shared" rule runs the other way, so
// the ownership checks are inline rather than a requireOwned* middleware:
// every account READS any performance (a 404 is a performance that does not
// exist, never one the viewer may not see), and only the writes ask whose it
// is. The two reads of ONE performance — the page and the patch it shows —
// take an optional session rather than a required one, because a performance
// its author marked public is read by anyone with the link; a visitor with
// no session gets a 401 on a private one, which the page turns into "log in
// to see this". What each person may do is spelled out in
// services/performances.js.

import { Router } from 'express';
import { optionalAuth, requireAuth } from '../auth.js';
import { loadPatchDetail, patchJson } from '../services/patchDetail.js';
import {
  MAX_COMMENT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  canDeletePerformance,
  canEditPerformance,
  canReadPerformance,
  canRemoveComment,
  commentJson,
  listPerformances,
  loadPerformance,
  readModuleIds,
  readPatch,
  readVideo,
  replaceModules,
  text,
} from '../services/performances.js';
import { asyncHandler } from './asyncHandler.js';

export function performanceRoutes(db) {
  const { Performance, PerformanceComment, Patch, User } = db.models;
  const router = Router();
  const auth = requireAuth(db);
  const maybeAuth = optionalAuth(db);

  const DEFAULT_PAGE = 50;
  const MAX_PAGE = 200;

  // The performance named in the path, or null once the 404 — or, for a
  // visitor with no session at a private one, the 401 — has been sent.
  const find = async (req, res) => {
    const row = await Performance.findByPk(Number(req.params.id) || 0);
    if (!row) {
      res.status(404).json({ error: 'Performance not found' });
      return null;
    }
    if (!canReadPerformance(row, req.user)) {
      res.status(401).json({ error: 'Log in to see this performance' });
      return null;
    }
    return row;
  };

  const readPublic = (value) => {
    if (value === undefined) return { skip: true };
    if (typeof value !== 'boolean') return { error: 'public must be true or false' };
    return { value };
  };

  // The fields a create and an edit share, read off the body: each is
  // { value } to set, { skip } to leave alone, or { error }.
  const readFields = async (req, { creating }) => {
    const body = req.body || {};
    const values = {};
    if (creating || body.url !== undefined) {
      const video = readVideo(body.url);
      if (video.error) return { error: video.error };
      values.url = video.url;
      values.video_id = video.video_id;
    }
    if (creating || body.title !== undefined) {
      const title = text(body.title, MAX_TITLE_LENGTH);
      if (!title) return { error: 'A performance needs a title' };
      values.title = title;
    }
    if (body.description !== undefined) {
      values.description = text(body.description, MAX_DESCRIPTION_LENGTH);
    }
    const open = readPublic(body.public);
    if (open.error) return { error: open.error };
    if (!open.skip) values.public = open.value;
    const patch = await readPatch(db, req.user.id, body.patch_id);
    if (patch.error) return { error: patch.error };
    if (!patch.skip) {
      values.patch_id = patch.patch?.id ?? null;
      values.patch_name = patch.patch?.name ?? null;
    }
    const modules = await readModuleIds(db, req.user.id, body.module_ids);
    if (modules.error) return { error: modules.error };
    return { values, moduleIds: modules.skip ? null : modules.ids };
  };

  // GET /api/performances?limit&before&mine — one page of everyone's, newest
  // first; `mine=1` narrows it to the viewer's own. The list is the room's,
  // so it takes an account; a public performance is reached by its link.
  router.get('/', auth, asyncHandler(async (req, res) => {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
    const before = Math.max(0, Number(req.query.before) || 0);
    const mine = req.query.mine === '1' || req.query.mine === 'true';
    res.json(await listPerformances(db, req.user, { limit, before, mine }));
  }));

  // Body: { url, title, description?, public?, patch_id?, module_ids? }
  router.post('/', auth, asyncHandler(async (req, res) => {
    const read = await readFields(req, { creating: true });
    if (read.error) return res.status(400).json({ error: read.error });
    const row = await db.sequelize.transaction(async (transaction) => {
      const created = await Performance.create(
        { user_id: req.user.id, ...read.values },
        { transaction }
      );
      if (read.moduleIds) await replaceModules(db, created.id, read.moduleIds, { transaction });
      return created;
    });
    res.status(201).json(await loadPerformance(db, row, req.user));
  }));

  router.get('/:id', maybeAuth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    res.json(await loadPerformance(db, row, req.user));
  }));

  // The patch the author chose to show, read the way a shared patch is: the
  // picture and the cables, without the private layout of the rack it sits
  // in. 404 when none is shown, or when the patch has since been deleted.
  router.get('/:id/patch', maybeAuth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    const patch = row.patch_id ? await Patch.findByPk(row.patch_id) : null;
    if (!patch) return res.status(404).json({ error: 'This performance shows no patch' });
    const { json } = await loadPatchDetail(db, patch, { includeRackLayout: false, describe: false });
    const owner = await User.findByPk(patch.user_id);
    res.json(
      patchJson(patch, {
        ...json,
        generating: false,
        shared: patch.user_id !== req.user?.id,
        owner_username: owner?.username ?? null,
      })
    );
  }));

  // Body: any of { url, title, description, public, patch_id (null withdraws
  // the patch), module_ids (the whole list) } — each omitted field is left
  // alone.
  router.put('/:id', auth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    if (!canEditPerformance(row, req.user)) {
      return res.status(403).json({ error: 'Only the author can change a performance' });
    }
    const read = await readFields(req, { creating: false });
    if (read.error) return res.status(400).json({ error: read.error });
    await db.sequelize.transaction(async (transaction) => {
      await row.update(read.values, { transaction });
      if (read.moduleIds) await replaceModules(db, row.id, read.moduleIds, { transaction });
    });
    res.json(await loadPerformance(db, row, req.user));
  }));

  router.delete('/:id', auth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    if (!canDeletePerformance(row, req.user)) {
      return res.status(403).json({ error: 'Only the author or an admin can delete a performance' });
    }
    await row.destroy();
    res.json({ ok: true });
  }));

  // Body: { body }. An account's alone, public performance or not.
  router.post('/:id/comments', auth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    const body = text(req.body?.body, MAX_COMMENT_LENGTH);
    if (!body) return res.status(400).json({ error: 'A comment needs some words' });
    const comment = await PerformanceComment.create({
      performance_id: row.id,
      user_id: req.user.id,
      body,
    });
    res
      .status(201)
      .json(commentJson(comment, { username: req.user.username, performance: row, viewer: req.user }));
  }));

  router.delete('/:id/comments/:commentId', auth, asyncHandler(async (req, res) => {
    const row = await find(req, res);
    if (!row) return;
    const comment = await PerformanceComment.findOne({
      where: { id: Number(req.params.commentId) || 0, performance_id: row.id },
    });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (!canRemoveComment(comment, row, req.user)) {
      return res.status(403).json({ error: 'Only its writer, the author or an admin can remove a comment' });
    }
    await comment.destroy();
    res.json({ ok: true });
  }));

  return router;
}
