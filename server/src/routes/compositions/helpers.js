// Helpers shared by the /api/compositions sub-routers.

export function ownComposition(db, userId, id) {
  const { Composition } = db.models;
  return Composition.findOne({ where: { id: Number(id) || 0, user_id: userId } });
}

// Route middleware: the composition under :id, if this user owns it, onto
// req.composition. Compositions are private to their owner.
export function requireOwnedComposition(db) {
  return (req, res, next) => {
    ownComposition(db, req.user.id, req.params.id)
      .then((composition) => {
        if (!composition) return res.status(404).json({ error: 'Composition not found' });
        req.composition = composition;
        next();
      })
      .catch(next);
  };
}

// Route middleware for the mapping routes: the composition under :id AND the
// patch under :patchId, both this user's, and the realization row that pairs
// them — onto req.composition, req.patch and req.realization. A patch that
// is yours but not mapped onto this composition is 404 too: the URL names a
// pair that does not exist.
export function requireOwnedRealization(db) {
  const { Patch, CompositionPatch } = db.models;
  return (req, res, next) => {
    (async () => {
      const composition = await ownComposition(db, req.user.id, req.params.id);
      if (!composition) return res.status(404).json({ error: 'Composition not found' });
      const patch = await Patch.findOne({
        where: { id: Number(req.params.patchId) || 0, user_id: req.user.id },
      });
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const realization = await CompositionPatch.findOne({
        where: { composition_id: composition.id, patch_id: patch.id },
      });
      if (!realization) {
        return res.status(404).json({ error: 'This composition is not mapped onto that patch' });
      }
      req.composition = composition;
      req.patch = patch;
      req.realization = realization;
      next();
    })().catch(next);
  };
}

// A whole number at or above zero, or null for anything else.
export function wholeNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
