// Patching WITH the model, one cable each.
//
// The generator (patchGenerator.js) builds a patch in one go. This is the
// same model at the other pace: COLLABORATION MODE is switched on for a
// patch, the user plugs a cable, and the model answers with exactly one of
// its own — building on what the user just did, steered by the brief the
// mode was given ("a slow drone", "keep it percussive") — and then waits for
// the user's next move. Switched on with `PUT /api/patches/:id/collaboration`
// and recorded on the patch row (migration 050), because a cable plugged on
// the picture, on the cable list or by voice is a move whichever page it
// came from, and `POST /api/patches/:id/cables` queues a `patch_turn` job
// for each one while the mode is on.
//
// A turn is the generator's machinery over a budget of ONE: the same
// inventory, the same rules, the same `judgeCables()` over the same
// `cableProblem()` a hand-plugged cable meets. The model is asked for a few
// cables in order of preference and the first legal one is the move; a
// setting or two may ride along when the cable needs one to be heard (a VCA
// opened, a switch set), and nothing else is touched — no settings review,
// no rewritten description. A model whose every proposal is refused gets one
// more round with the refusals in front of it, and a turn that still finds
// no legal cable fails the job for good rather than retrying: it is the
// patch that has no move left, not the attempt.
//
// The user's move is answered ONCE. A cable plugged while a turn is already
// queued joins the patch the queued turn will read, rather than queueing a
// second; a cable plugged while a turn is RUNNING does queue one, because
// the running turn read the patch before it landed and would never see it.

import { enqueueJob } from '../jobs/enqueue.js';
import {
  CABLE_RULES,
  MAX_BRIEF_CHARS,
  MAX_GENERATED_CABLES,
  MODEL_PATCH_JOB_TYPES,
  clip,
  instanceLabel,
  judgeCables,
  parseGeneratedPatch,
  readPatch,
  writeSettings,
} from './patchGenerator.js';

// How many times the model is asked before the turn is given up: the second
// round only ever follows a first whose every cable was refused.
export const MAX_TURN_ROUNDS = 2;
// How many cables the model may offer in order of preference — the first
// legal one is the move, the rest are the fallbacks that save a round.
export const TURN_CHOICES = 3;
// A turn dials in what its cable needs to be heard, not the whole patch.
export const MAX_TURN_SETTINGS = 4;

// The brief the mode is given, checked: text at most MAX_BRIEF_CHARS long,
// null for none. Answers { value } or { error }.
export function readCollaborationPrompt(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'prompt must be text' };
  const text = raw.trim();
  if (text.length > MAX_BRIEF_CHARS) {
    return { error: `prompt must be ${MAX_BRIEF_CHARS} characters or fewer` };
  }
  return { value: text || null };
}

// The one prompt of a turn. `move` is the user's latest cable as text (null
// when it has already been unplugged again); `refused` is what the model's
// previous round proposed and why each was thrown out, on the second round.
export const TURN_TEMPLATE = (
  inventory,
  { brief = '', move = null, refused = [], round = 1, sinks = 0 } = {}
) => `You are a eurorack modular synthesizer expert patching a user's own system TOGETHER WITH THEM, taking turns: they plug a cable, you plug the next one, and so on. It is your turn.

${
  brief
    ? `What the two of you are making — the user's brief:\n\n${brief}\n\nEvery move you make should take the patch towards that.`
    : 'No brief was given: build on what the user is doing towards a patch that can be heard and played.'
}

${
  move
    ? `The user's latest move: ${move}\n\nRead it as a statement of intent — what they seem to be building — and answer it: complete the path they started, modulate what they just connected, feed what they routed into, or carry the sound on towards the output. A move that builds on theirs beats a move that starts something new.`
    : 'The user has just changed the patch; the inventory below shows it as it now stands.'
}${
  sinks > 0
    ? '\n\nThe inventory names the jacks sound leaves the system at. Until the patch reaches one of them nobody hears it: when nothing else is more pressing, that is the move.'
    : ''
}${
  refused.length > 0
    ? `\n\nThis is round ${round}: every cable you proposed last round was REFUSED, for the reason given —\n${refused
        .map((r) => `- ${r.text}: ${r.reason}`)
        .join('\n')}\nPropose different cables this time; re-read the inventory for which inputs are already taken.`
    : ''
}

Plug EXACTLY ONE cable: offer up to ${TURN_CHOICES} in order of preference, and the first legal one is the one plugged — the others are only fallbacks. Where that cable needs a control or menu setting to be heard at all (a VCA that must be open, a switch that selects the input you used), dial in that setting too, and change nothing else: the rest of the patch is the user's to set.

${CABLE_RULES}
- Never repeat a cable that is already patched, and never unplug one: every cable in the patch is the user's or an earlier move of yours, and both stand.

Respond with ONLY a JSON object of this shape (no prose around it):
{
  "cables": [
    { "from_module": <instance id>, "from_jack": <jack id>, "to_module": <instance id>, "to_jack": <jack id>, "note": "why — one sentence, said to the user" }
  ],
  "settings": [
    { "module": <instance id>, "component": <control id>, "value": "<position or number>" },
    { "module": <instance id>, "parameter": <parameter id>, "value": "<option or number>" }
  ]
}

${inventory}
`;

// A cable as the prompt and the log name it.
const cableText = (json, cable) => {
  const byId = new Map((json.modules ?? []).map((pm) => [pm.id, pm]));
  const from = byId.get(cable.from_patch_module_id);
  const to = byId.get(cable.to_patch_module_id);
  return (
    `${from ? instanceLabel(from) : '?'} "${cable.from_component_name}" (instance ${cable.from_patch_module_id}, jack ${cable.from_component_id}) → ` +
    `${to ? instanceLabel(to) : '?'} "${cable.to_component_name}" (instance ${cable.to_patch_module_id}, jack ${cable.to_component_id})` +
    (cable.note ? ` — "${clip(cable.note, 120)}"` : '')
  );
};

// One turn: read the patch, ask for a cable, keep the first legal one, write
// it with the settings it came with. `cableId` is the user's move, named so
// the model is told what it is answering. Answers { text, note, settings,
// refused } — the cable plugged, as text and with the model's reason, how
// many settings were written and how many proposals the rules threw out.
export async function takePatchTurn(
  db,
  backend,
  patch,
  { brief = '', cableId = null, log = () => {} } = {}
) {
  const { PatchCable } = db.models;
  const state = await readPatch(db, patch);
  const rows = (await PatchCable.findAll({ where: { patch_id: patch.id } })).map((c) =>
    c.get({ plain: true })
  );
  if (rows.length >= MAX_GENERATED_CABLES) {
    const full = new Error(`the patch already holds ${MAX_GENERATED_CABLES} cables, the most the model will patch`);
    full.permanent = true;
    throw full;
  }
  if (!state.json.modules.some((pm) => pm.components.some((c) => String(c.type).endsWith('_jack')))) {
    const bare = new Error('none of the modules in this patch has analyzed jacks yet — analyze their manuals first');
    bare.permanent = true;
    throw bare;
  }
  const users = cableId ? rows.find((c) => c.id === cableId) : null;
  const move = users ? cableText(state.json, users) : null;
  log(
    move
      ? `answering the user's move: ${move}`
      : 'the user changed the patch; answering with one cable' + (brief ? ` — brief: ${clip(brief, 120)}` : '')
  );

  let refused = [];
  let refusedTotal = 0;
  for (let round = 1; round <= MAX_TURN_ROUNDS; round += 1) {
    if (round > 1) log(`round ${round}: every cable was refused; asking again`);
    const proposal = parseGeneratedPatch(
      await backend.completeText(
        TURN_TEMPLATE(state.inventory, {
          brief,
          move,
          refused,
          round,
          sinks: state.sinks.length,
        })
      ),
      { maxCables: TURN_CHOICES }
    );
    log(`the model offered ${proposal.cables.length} cable(s) and ${proposal.settings.length} setting(s)`);
    // A budget of one more than the patch holds: the first legal cable is
    // kept and the judge stops there.
    const judged = await judgeCables(
      db,
      patch,
      proposal.cables.slice(0, TURN_CHOICES),
      rows,
      rows.length + 1,
      log
    );
    refused = judged.refused;
    refusedTotal += judged.refused.length;
    const kept = judged.kept[0];
    if (!kept) {
      if (judged.refused.length === 0) break;
      continue;
    }
    let settings = 0;
    await db.sequelize.transaction(async (transaction) => {
      const created = await PatchCable.create(kept.row, { transaction });
      kept.row.id = created.id;
      settings = await writeSettings(
        db,
        patch,
        proposal.settings.slice(0, MAX_TURN_SETTINGS),
        state.topology.jacksByPatchModule,
        log,
        transaction
      );
    });
    return { text: kept.text, note: kept.row.note, settings, refused: refusedTotal };
  }
  const stuck = new Error(
    refusedTotal === 0
      ? 'the model proposed no cable'
      : `none of the ${refusedTotal} cable(s) the model proposed was legal — the patch may have no free input left for it`
  );
  // Not the attempt's fault: the same patch gets the same answer.
  stuck.permanent = true;
  throw stuck;
}

// The model's turn, queued for a cable the user just plugged — when the
// patch is in collaboration mode and no turn is already waiting. A turn that
// is RUNNING read the patch before this cable landed, so it does not count
// as waiting; a live generate_patch job does, since it is about to plug
// cables of its own. Answers the job, or null when none was queued.
export async function enqueuePatchTurn(db, patch, { cableId = null } = {}) {
  if (!patch.collaborating) return null;
  const live = await db.models.Job.findAll({
    where: { type: MODEL_PATCH_JOB_TYPES, user_id: patch.user_id, status: ['pending', 'running'] },
    attributes: ['type', 'status', 'payload'],
  });
  const waiting = live.some((job) => {
    try {
      if (Number(JSON.parse(job.payload || '{}').patch_id) !== patch.id) return false;
    } catch {
      return false;
    }
    return job.type === 'generate_patch' || job.status === 'pending';
  });
  if (waiting) return null;
  return enqueueJob(db, 'patch_turn', {
    userId: patch.user_id,
    payload: {
      patch_id: patch.id,
      patch_name: patch.name,
      prompt: patch.collaboration_prompt || null,
      cable_id: cableId,
    },
  });
}
