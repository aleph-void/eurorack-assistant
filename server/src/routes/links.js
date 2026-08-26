// Links on a module, a patch, a rack or a system.
//
// One router for all four owners rather than a sub-route on each, because a
// link is the same row and the same four operations whichever record it
// hangs off — the owner is named in the query (to list) or the body (to
// create), and checked against what this user actually has.
//
// Links are private: a module record is shared between everyone who racked
// it, but the thread you found about its firmware is yours.

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  linkJson,
  linksFor,
  normalizeUrl,
  ownsLinkTarget,
  readLinkOwner,
  titleFromUrl,
} from '../services/resourceLinks.js';
import { asyncHandler } from './asyncHandler.js';

const text = (value, max) => {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

export function linkRoutes(db) {
  const { ResourceLink } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const ownLink = (userId, id) =>
    ResourceLink.findOne({ where: { id: Number(id) || 0, user_id: userId } });

  // The links on one record: /api/links?module_id=12 (or patch_id, rack_id,
  // system_id). Naming no record is an error rather than "all of them" —
  // a flat list of every link you have ever saved is not a page anything
  // asks for, and it would be a page nothing can act on.
  router.get('/', asyncHandler(async (req, res) => {
    const owner = readLinkOwner(req.query);
    if (owner.error) return res.status(400).json({ error: owner.error });
    if (!(await ownsLinkTarget(db, req.user.id, owner))) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json(await linksFor(db, req.user.id, owner));
  }));

  // Body: { module_id|patch_id|rack_id|system_id, url, title?, description? }
  router.post('/', asyncHandler(async (req, res) => {
    const owner = readLinkOwner(req.body || {});
    if (owner.error) return res.status(400).json({ error: owner.error });
    if (!(await ownsLinkTarget(db, req.user.id, owner))) {
      return res.status(404).json({ error: 'Record not found' });
    }
    const { url, error } = normalizeUrl(req.body?.url);
    if (error) return res.status(400).json({ error });

    // New links go at the end of the list rather than the top: the order is
    // the user's, and a link added today does not outrank the manual page
    // they put first.
    const last = await ResourceLink.findOne({
      where: { user_id: req.user.id, [owner.key]: owner.id },
      order: [['position', 'DESC']],
    });
    const link = await ResourceLink.create({
      user_id: req.user.id,
      [owner.key]: owner.id,
      url,
      title: text(req.body?.title, MAX_TITLE_LENGTH) ?? titleFromUrl(url),
      description: text(req.body?.description, MAX_DESCRIPTION_LENGTH),
      position: (last?.position ?? -1) + 1,
    });
    res.status(201).json(linkJson(link));
  }));

  // Body: { url?, title?, description?, position? } — each omitted field is
  // left alone, and an emptied title falls back to the URL's host rather
  // than leaving a row with nothing to click.
  router.put('/:id', asyncHandler(async (req, res) => {
    const link = await ownLink(req.user.id, req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const values = {};
    if (req.body?.url !== undefined) {
      const { url, error } = normalizeUrl(req.body.url);
      if (error) return res.status(400).json({ error });
      values.url = url;
    }
    if (req.body?.title !== undefined) {
      values.title = text(req.body.title, MAX_TITLE_LENGTH) ?? titleFromUrl(values.url ?? link.url);
    }
    if (req.body?.description !== undefined) {
      values.description = text(req.body.description, MAX_DESCRIPTION_LENGTH);
    }
    if (req.body?.position !== undefined) {
      const position = Number(req.body.position);
      if (!Number.isInteger(position) || position < 0) {
        return res.status(400).json({ error: 'position must be a whole number' });
      }
      values.position = position;
    }
    await link.update(values);
    res.json(linkJson(link));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const link = await ownLink(req.user.id, req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    await link.destroy();
    res.json({ ok: true });
  }));

  return router;
}
