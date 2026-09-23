import { Router } from 'express';
import { patchJson } from '../../services/patchDetail.js';
import { readCollaborationPrompt } from '../../services/patchTurn.js';
import { requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// Collaboration mode: the model answers every cable the user plugs with one
// of its own (services/patchTurn.js). Switched on and off here, with the
// brief the model is steered by; the turns themselves are queued by the
// cable route, and the patch payload says where things stand
// (`collaboration`, and `generating` while a turn is being taken).
export function patchCollaborationRoutes(db) {
  const router = Router();

  // Body: { enabled: boolean, prompt?: string | null }. The prompt is kept
  // when the body does not mention it, so the mode can be switched off and
  // on again without retyping the brief; null or '' clears it.
  router.put('/:id/collaboration', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    const updates = {};
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be true or false' });
      }
      updates.collaborating = req.body.enabled;
    }
    if (req.body?.prompt !== undefined) {
      const prompt = readCollaborationPrompt(req.body.prompt);
      if (prompt.error) return res.status(400).json({ error: prompt.error });
      updates.collaboration_prompt = prompt.value;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'enabled or prompt is required' });
    }
    await patch.update(updates);
    res.json(patchJson(patch));
  }));

  return router;
}
