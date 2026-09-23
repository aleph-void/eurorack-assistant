// A question's own lifecycle: the list, one question with its answer, asking
// a new one, and deleting one.
//
// Asking does not answer: POST / queues a scope_question job, and the review
// step in ./review.js is what turns a scoped question into an answered one.
//
// Unless the asker already said what the question is about. A question asked
// from a MODULE's page names its own scope — that module, and the components
// of it the asker ticked — so there is nothing for a scoping model to work
// out: the question is created 'scoped' with those links written and NO
// scope_question job, and lands straight in the review step. A question asked
// about a RACK or a SYSTEM is the same thing one level up: its scope is every
// module of the rack (or of every rack in the system), written as the same
// module links, with the rack or system itself recorded beside them so its
// own questions panel can list the question.

import { Router } from 'express';
import { userModuleIds } from '../../services/racks.js';
import { requireBudget } from '../../services/budgets.js';
import { requireLlmAccount } from '../../services/llmAccounts.js';
import { readableResource, removeShares } from '../../services/sharing.js';
import { audioJson } from '../../services/audio.js';
import { asyncHandler } from '../asyncHandler.js';
import { uniqueIds } from './helpers.js';

export function questionCoreRoutes(db) {
  const {
    Question,
    QuestionModule,
    QuestionComponent,
    QuestionManual,
    QuestionAnswer,
    QuestionNote,
    QuestionCapture,
    QuestionAudio,
    QuestionPatch,
    QuestionRack,
    QuestionSystem,
    Patch,
    Rack,
    RackModule,
    System,
    Module,
    ModuleComponent,
    Manual,
    Note,
    Capture,
    AudioRecording,
    User,
    Job,
  } = db.models;
  const router = Router();

  // Your questions, newest first — and the same list narrowed to one module
  // or one patch, which is what the questions page OF a module (or of a
  // patch) reads: a question belongs to a module when that module is in its
  // scope, and to a patch when that patch is attached to it. The link rows
  // are read first and the ids handed to the question query, rather than
  // joined: pg-mem drops rows from an OR ANDed with anything else, and a
  // flat page filtered in JS is the house workaround.
  router.get('/', asyncHandler(async (req, res) => {
    const where = { user_id: req.user.id };
    const narrow = (ids) => {
      where.id = Array.isArray(where.id) ? where.id.filter((id) => ids.includes(id)) : ids;
    };
    const moduleId = Number(req.query.module_id);
    if (Number.isInteger(moduleId) && moduleId > 0) {
      const links = await QuestionModule.findAll({ where: { module_id: moduleId } });
      narrow([...new Set(links.map((l) => l.question_id))]);
    }
    const patchId = Number(req.query.patch_id);
    if (Number.isInteger(patchId) && patchId > 0) {
      const links = await QuestionPatch.findAll({ where: { patch_id: patchId } });
      narrow([...new Set(links.map((l) => l.question_id))]);
    }
    // A rack's questions are the ones asked ABOUT the rack, not every question
    // touching a module in it: a question about one module of the case is
    // that module's, and is listed on its page.
    const rackId = Number(req.query.rack_id);
    if (Number.isInteger(rackId) && rackId > 0) {
      const links = await QuestionRack.findAll({ where: { rack_id: rackId } });
      narrow([...new Set(links.map((l) => l.question_id))]);
    }
    const systemId = Number(req.query.system_id);
    if (Number.isInteger(systemId) && systemId > 0) {
      const links = await QuestionSystem.findAll({ where: { system_id: systemId } });
      narrow([...new Set(links.map((l) => l.question_id))]);
    }
    if (Array.isArray(where.id) && where.id.length === 0) return res.json([]);

    const questions = await Question.findAll({
      where,
      attributes: ['id', 'prompt', 'status', 'error', 'created_at', 'answered_at'],
      order: [
        ['created_at', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    res.json(questions);
  }));

  // Yours, or one somebody shared with you. A shared question is the question
  // and its answer, read-only: the review step and the delete below find it
  // under its owner alone, so a reader can neither re-answer nor remove it.
  router.get('/:id', asyncHandler(async (req, res) => {
    const found = await readableResource(db, req.user.id, 'question', req.params.id);
    if (!found) return res.status(404).json({ error: 'Question not found' });
    const question = found.row;
    const owner = found.shared ? await User.findByPk(question.user_id) : null;
    // A shared question is served to someone who is not its owner. Its
    // answer and the global hardware it names (modules, components) travel
    // with the share; the owner's private cross-references — the notes,
    // captures, patches and prior questions they attached as context, and
    // the manuals (whose hash fingerprints a possibly-private upload) — do
    // not. Skip those queries entirely for a share recipient.
    const includePrivate = !found.shared;
    const links = await QuestionModule.findAll({
      where: { question_id: question.id },
      include: Module,
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
      ],
    });
    const componentLinks = await QuestionComponent.findAll({
      where: { question_id: question.id },
      include: [{ model: ModuleComponent, include: [Module] }],
      order: [[ModuleComponent, 'id', 'ASC']],
    });
    const manualLinks = includePrivate
      ? await QuestionManual.findAll({
          where: { question_id: question.id },
          include: [{ model: Manual, include: [Module] }],
          order: [['manual_id', 'ASC']],
        })
      : [];
    const answerLinks = includePrivate
      ? await QuestionAnswer.findAll({
          where: { question_id: question.id },
          include: [{ model: Question, as: 'SourceQuestion' }],
          order: [['source_question_id', 'ASC']],
        })
      : [];
    const noteLinks = includePrivate
      ? await QuestionNote.findAll({
          where: { question_id: question.id },
          include: Note,
          order: [['note_id', 'ASC']],
        })
      : [];
    const captureLinkRows = includePrivate
      ? await QuestionCapture.findAll({
          where: { question_id: question.id },
          include: Capture,
          order: [['capture_id', 'ASC']],
        })
      : [];
    const audioLinkRows = includePrivate
      ? await QuestionAudio.findAll({
          where: { question_id: question.id },
          include: AudioRecording,
          order: [['audio_id', 'ASC']],
        })
      : [];
    const patchLinkRows = includePrivate
      ? await QuestionPatch.findAll({
          where: { question_id: question.id },
          include: Patch,
          order: [['patch_id', 'ASC']],
        })
      : [];
    // The rack or system it was asked about, if it was: the owner's inventory,
    // so, like the patches, not part of what a share carries.
    const rackLinkRows = includePrivate
      ? await QuestionRack.findAll({
          where: { question_id: question.id },
          include: Rack,
          order: [['rack_id', 'ASC']],
        })
      : [];
    const systemLinkRows = includePrivate
      ? await QuestionSystem.findAll({
          where: { question_id: question.id },
          include: System,
          order: [['system_id', 'ASC']],
        })
      : [];
    res.json({
      ...question.get({ plain: true }),
      shared: found.shared,
      owner_username: owner?.username ?? req.user.username,
      modules: links.map(({ Module: m }) => ({
        id: m.id,
        manufacturer: m.manufacturer,
        name: m.name,
      })),
      components: componentLinks.map(({ ModuleComponent: mc }) => ({
        id: mc.id,
        name: mc.name,
        type: mc.type,
        module_id: mc.module_id,
        module_manufacturer: mc.Module.manufacturer,
        module_name: mc.Module.name,
      })),
      manuals: manualLinks.map(({ Manual: m }) => ({
        id: m.id,
        module_id: m.module_id,
        name: m.name,
        original_name: m.original_name,
        hash: m.hash,
        module_manufacturer: m.Module.manufacturer,
        module_name: m.Module.name,
      })),
      answers: answerLinks.map(({ SourceQuestion: q }) => ({
        id: q.id,
        prompt: q.prompt,
        answered_at: q.answered_at,
      })),
      notes: noteLinks.map(({ Note: n }) => ({ id: n.id, title: n.title })),
      captures: captureLinkRows
        .filter((l) => l.Capture)
        .map(({ Capture: c }) => ({
          id: c.id,
          title: c.title,
          patch_id: c.patch_id,
          captured_at: c.captured_at,
          image_hash: c.image_hash,
        })),
      audio: audioLinkRows
        .filter((l) => l.AudioRecording)
        .map(({ AudioRecording: a }) => audioJson(a)),
      patches: patchLinkRows
        .filter((l) => l.Patch)
        .map(({ Patch: p }) => ({ id: p.id, name: p.name, rack_name: p.rack_name })),
      racks: rackLinkRows.filter((l) => l.Rack).map(({ Rack: r }) => ({ id: r.id, name: r.name })),
      systems: systemLinkRows
        .filter((l) => l.System)
        .map(({ System: s }) => ({ id: s.id, name: s.name })),
    });
  }));

  // Questions are scoped asynchronously by the job worker; the client polls
  // and then presents the review step. One asked about a named module skips
  // that pass entirely and comes back ready to review.
  router.post('/', requireBudget(db), requireLlmAccount(db), asyncHandler(async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const ownedIds = await userModuleIds(db, req.user.id);
    if (ownedIds.length === 0) {
      return res.status(400).json({ error: 'Import some modules before asking questions' });
    }

    // Asking about a patch: the patch is attached before scoping, so the
    // modules it uses are in scope from the start of the review step.
    const patchIds = uniqueIds(
      req.body?.patch_ids ?? (req.body?.patch_id ? [req.body.patch_id] : [])
    );
    if (patchIds.length > 0) {
      const owned = await Patch.count({ where: { id: patchIds, user_id: req.user.id } });
      if (owned !== patchIds.length) {
        return res.status(400).json({ error: 'patch_ids must be your patches' });
      }
    }

    // Asking about a MODULE: the asker has already said what the question is
    // about — a question asked from a module's page is about that module even
    // when its name never appears in the sentence ("why is this so quiet?").
    const namedModuleIds = uniqueIds(
      req.body?.module_ids ?? (req.body?.module_id ? [req.body.module_id] : [])
    );
    if (namedModuleIds.length > 0) {
      const owned = new Set(ownedIds);
      if (!namedModuleIds.every((id) => owned.has(id))) {
        return res.status(400).json({ error: 'module_ids must be modules in your racks' });
      }
    }

    // Asking about a RACK, or a SYSTEM: the question is about everything in
    // it, so every module of the rack — of every rack in the system — goes
    // into the module scope, and the rack or system is recorded beside them
    // so its own questions panel can find the question again. A rack the
    // user does not own is a 400 like a foreign module; a system's racks are
    // whichever stand in it now, which is what "the system" means today.
    const systemIds = uniqueIds(
      req.body?.system_ids ?? (req.body?.system_id ? [req.body.system_id] : [])
    );
    if (systemIds.length > 0) {
      const owned = await System.count({ where: { id: systemIds, user_id: req.user.id } });
      if (owned !== systemIds.length) {
        return res.status(400).json({ error: 'system_ids must be your systems' });
      }
    }
    const rackIds = uniqueIds(req.body?.rack_ids ?? (req.body?.rack_id ? [req.body.rack_id] : []));
    if (rackIds.length > 0) {
      const owned = await Rack.count({ where: { id: rackIds, user_id: req.user.id } });
      if (owned !== rackIds.length) {
        return res.status(400).json({ error: 'rack_ids must be your racks' });
      }
    }
    const scopedRackIds = [...rackIds];
    if (systemIds.length > 0) {
      const racks = await Rack.findAll({
        attributes: ['id'],
        where: { system_id: systemIds, user_id: req.user.id },
      });
      for (const rack of racks) {
        if (!scopedRackIds.includes(rack.id)) scopedRackIds.push(rack.id);
      }
    }
    const moduleIds = [...namedModuleIds];
    if (scopedRackIds.length > 0) {
      const mappings = await RackModule.findAll({
        attributes: ['module_id'],
        where: { rack_id: scopedRackIds },
      });
      for (const { module_id: id } of mappings) {
        if (!moduleIds.includes(id)) moduleIds.push(id);
      }
      if (moduleIds.length === 0) {
        return res.status(400).json({ error: 'There are no modules in what you asked about' });
      }
    }

    // ...and which of its controls and jacks, if any: the components ticked
    // beside the box the question was typed in. They are the same links the
    // component scoping pass would have guessed at, so they go in as the
    // question's component scope and come back ticked in the review step.
    const componentIds = uniqueIds(req.body?.component_ids);
    if (componentIds.length > 0) {
      if (namedModuleIds.length === 0) {
        return res
          .status(400)
          .json({ error: 'component_ids must be components of the modules asked about' });
      }
      const owned = await ModuleComponent.count({
        where: { id: componentIds, module_id: namedModuleIds },
      });
      if (owned !== componentIds.length) {
        return res
          .status(400)
          .json({ error: 'component_ids must be components of the modules asked about' });
      }
    }

    // A named module IS the scope, so no model reads the wording to find one:
    // the question is created 'scoped' and skips the scope_question job
    // altogether. A question that also names a patch still goes through
    // scoping — a patch reaches modules beyond the one page it was asked
    // from — as does one that names no module at all.
    const preScoped = moduleIds.length > 0 && patchIds.length === 0;

    // The question and the job that scopes it are created together — a
    // question without its job would sit unscoped forever. A pre-scoped one
    // has no job to wait for: it is 'scoped' the moment it exists.
    const question = await db.sequelize.transaction(async (transaction) => {
      const created = await Question.create(
        { user_id: req.user.id, prompt, status: preScoped ? 'scoped' : 'scoping' },
        { transaction }
      );
      if (patchIds.length > 0) {
        await QuestionPatch.bulkCreate(
          patchIds.map((id) => ({ question_id: created.id, patch_id: id })),
          { transaction }
        );
      }
      if (moduleIds.length > 0) {
        await QuestionModule.bulkCreate(
          moduleIds.map((id) => ({ question_id: created.id, module_id: id })),
          { transaction }
        );
      }
      if (rackIds.length > 0) {
        await QuestionRack.bulkCreate(
          rackIds.map((id) => ({ question_id: created.id, rack_id: id })),
          { transaction }
        );
      }
      if (systemIds.length > 0) {
        await QuestionSystem.bulkCreate(
          systemIds.map((id) => ({ question_id: created.id, system_id: id })),
          { transaction }
        );
      }
      if (componentIds.length > 0) {
        await QuestionComponent.bulkCreate(
          componentIds.map((id) => ({ question_id: created.id, component_id: id })),
          { transaction }
        );
      }
      if (!preScoped) {
        await Job.create(
          {
            type: 'scope_question',
            user_id: req.user.id,
            question_id: created.id,
            status: 'pending',
          },
          { transaction }
        );
      }
      return created;
    });
    res.status(201).json(question);
  }));

  // Deleting a question takes all of its records with it via the schema's
  // ON DELETE CASCADE rules: scope links, attachment selections, its own
  // jobs, and any question_answers rows citing it as a source (the citing
  // questions themselves are untouched).
  router.delete('/:id', asyncHandler(async (req, res) => {
    const question = await Question.findOne({
      where: { id: Number(req.params.id), user_id: req.user.id },
    });
    if (!question) return res.status(404).json({ error: 'Question not found' });
    await question.destroy();
    await removeShares(db, 'question', question.id);
    res.json({ ok: true });
  }));

  return router;
}
