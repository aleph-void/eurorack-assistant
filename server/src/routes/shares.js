import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import {
  incomingShares,
  isShareableType,
  listShares,
  outgoingShares,
  ownedResource,
  setShares,
  SHAREABLE,
  SHAREABLE_TYPES,
} from '../services/sharing.js';
import { asyncHandler } from './asyncHandler.js';

// Handing your own records to other people to read: notes, patches, questions
// and their answers, racks, and documents you uploaded.
//
// Managing a share is the owner's alone, so every route here except the two
// listings starts by finding the record UNDER THE REQUESTING USER — a record
// somebody else owns is a 404, the same answer as one that does not exist.
export function shareRoutes(db) {
  const { User } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Who a share can be addressed to. The user list proper is admin-only and
  // stays that way; picking a recipient needs names and ids and nothing else.
  router.get('/users', asyncHandler(async (req, res) => {
    const users = await User.findAll({
      where: { id: { [Op.ne]: req.user.id } },
      attributes: ['id', 'username'],
      order: [['username', 'ASC']],
    });
    res.json(users.map((u) => ({ id: u.id, username: u.username })));
  }));

  router.get('/incoming', asyncHandler(async (req, res) => {
    res.json(await incomingShares(db, req.user.id));
  }));

  router.get('/outgoing', asyncHandler(async (req, res) => {
    res.json(await outgoingShares(db, req.user.id));
  }));

  // The record whose sharing is being read or changed, or null once this has
  // answered the request with why not.
  async function target(req, res) {
    const { type, id } = req.params;
    if (!isShareableType(type)) {
      res.status(400).json({ error: `type must be one of ${SHAREABLE_TYPES.join(', ')}` });
      return null;
    }
    const row = await ownedResource(db, req.user.id, type, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    return row;
  }

  const shareState = async (type, row) => ({
    type,
    id: row.id,
    label: SHAREABLE[type].label(row),
    ...(await listShares(db, type, row.id)),
  });

  router.get('/:type/:id', asyncHandler(async (req, res) => {
    const row = await target(req, res);
    if (!row) return;
    res.json(await shareState(req.params.type, row));
  }));

  // Replace who may read this record. Body: { everyone?: boolean,
  // user_ids?: number[] }. Sending both is meaningful: everyone sees it, and
  // the named people stay named, so withdrawing "everyone" later leaves them
  // with the access they were given.
  router.put('/:type/:id', asyncHandler(async (req, res) => {
    const row = await target(req, res);
    if (!row) return;
    const everyone = Boolean(req.body?.everyone);
    const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const result = await setShares(db, {
      ownerId: req.user.id,
      type: req.params.type,
      id: row.id,
      everyone,
      userIds,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(await shareState(req.params.type, row));
  }));

  // Stop sharing entirely — the same as saving an empty recipient list.
  router.delete('/:type/:id', asyncHandler(async (req, res) => {
    const row = await target(req, res);
    if (!row) return;
    await setShares(db, {
      ownerId: req.user.id,
      type: req.params.type,
      id: row.id,
      everyone: false,
      userIds: [],
    });
    res.json(await shareState(req.params.type, row));
  }));

  return router;
}
