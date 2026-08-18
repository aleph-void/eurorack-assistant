// Questions go through a review step: POST / queues a scope_question job
// that determines which modules (and specific components) the question
// applies to; once the question is 'scoped' the user reviews the module and
// component selection and picks attachments (manual documents, previous
// answers, notes, oscilloscope captures) via GET /:id/options, and POST
// /:id/answer saves the selection and queues the answer_question job.

import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { engagedPatchModuleIds } from '../services/patchTopology.js';
import { userModuleIds } from '../services/racks.js';
import { requireBudget } from '../services/budgets.js';
import { requireLlmAccount } from '../services/llmAccounts.js';
import { readableResource, removeShares } from '../services/sharing.js';

// Positive integer ids from a client-supplied array, deduped.
function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

export function questionRoutes(db) {
  const {
    Question,
    QuestionModule,
    QuestionComponent,
    QuestionManual,
    QuestionAnswer,
    QuestionNote,
    QuestionCapture,
    QuestionPatch,
    Patch,
    Module,
    ModuleComponent,
    Manual,
    Note,
    NoteModule,
    NoteComponent,
    Capture,
    CaptureChannel,
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchModuleLink,
    User,
    Job,
  } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Which modules and components a set of captures is about: the jacks its
  // channels were watching, and the modules of the patch it was taken on.
  // Used both to offer captures in the review step and to check that the ones
  // submitted belong to the question's scope.
  async function captureLinks(captures) {
    const ids = captures.map((c) => c.id);
    const channels =
      ids.length === 0 ? [] : await CaptureChannel.findAll({ where: { capture_id: ids } });
    const componentIds = [
      ...new Set(channels.map((c) => c.component_id).filter((id) => Number.isInteger(id))),
    ];
    const componentRows =
      componentIds.length === 0
        ? []
        : await ModuleComponent.findAll({ where: { id: componentIds } });
    const moduleOfComponent = new Map(componentRows.map((c) => [c.id, c.module_id]));

    const patchIds = [...new Set(captures.map((c) => c.patch_id).filter(Boolean))];
    const patchModules =
      patchIds.length === 0 ? [] : await PatchModule.findAll({ where: { patch_id: patchIds } });
    const modulesOfPatch = new Map();
    for (const pm of patchModules) {
      if (!pm.module_id) continue;
      if (!modulesOfPatch.has(pm.patch_id)) modulesOfPatch.set(pm.patch_id, new Set());
      modulesOfPatch.get(pm.patch_id).add(pm.module_id);
    }

    const byCapture = new Map();
    for (const capture of captures) {
      const own = channels.filter((c) => c.capture_id === capture.id);
      const components = [
        ...new Set(own.map((c) => c.component_id).filter((id) => Number.isInteger(id))),
      ];
      const modules = new Set(
        components.map((id) => moduleOfComponent.get(id)).filter((id) => Number.isInteger(id))
      );
      for (const id of modulesOfPatch.get(capture.patch_id) ?? []) modules.add(id);
      byCapture.set(capture.id, {
        module_ids: [...modules],
        component_ids: components,
        channels: own,
      });
    }
    return byCapture;
  }

  // The modules each patch uses, keyed by patch id — the same "actually in
  // play" rule the signal flow and the patch document use.
  async function patchModulesByPatch(patchIds) {
    const byPatch = new Map();
    if (patchIds.length === 0) return byPatch;
    const where = { patch_id: patchIds };
    const [rows, cables, settings, links] = await Promise.all([
      PatchModule.findAll({ where }),
      PatchCable.findAll({ where }),
      PatchSetting.findAll({ where }),
      PatchModuleLink.findAll({ where }),
    ]);
    for (const id of patchIds) {
      const engaged = engagedPatchModuleIds({
        cables: cables.filter((c) => c.patch_id === id),
        settings: settings.filter((s) => s.patch_id === id),
        links: links.filter((l) => l.patch_id === id),
      });
      byPatch.set(
        id,
        [
          ...new Set(
            rows
              .filter((pm) => pm.patch_id === id && engaged.has(pm.id) && pm.module_id)
              .map((pm) => pm.module_id)
          ),
        ]
      );
    }
    return byPatch;
  }

  router.get('/', async (req, res, next) => {
    try {
      const questions = await Question.findAll({
        where: { user_id: req.user.id },
        attributes: ['id', 'prompt', 'status', 'error', 'created_at', 'answered_at'],
        order: [
          ['created_at', 'DESC'],
          ['id', 'DESC'],
        ],
      });
      res.json(questions);
    } catch (e) {
      next(e);
    }
  });

  // Yours, or one somebody shared with you. A shared question is the question
  // and its answer, read-only: the review step and the delete below find it
  // under its owner alone, so a reader can neither re-answer nor remove it.
  router.get('/:id', async (req, res, next) => {
    try {
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
      const patchLinkRows = includePrivate
        ? await QuestionPatch.findAll({
            where: { question_id: question.id },
            include: Patch,
            order: [['patch_id', 'ASC']],
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
        patches: patchLinkRows
          .filter((l) => l.Patch)
          .map(({ Patch: p }) => ({ id: p.id, name: p.name, rack_name: p.rack_name })),
      });
    } catch (e) {
      next(e);
    }
  });

  // Everything the user can select in the review step: their whole rack and
  // its components (flagging what the LLM scoped in), plus manual documents,
  // previously answered questions, and notes — the latter two linkable via
  // either a module or a specific component.
  router.get('/:id/options', async (req, res, next) => {
    try {
      const question = await Question.findOne({
        where: { id: Number(req.params.id), user_id: req.user.id },
      });
      if (!question) return res.status(404).json({ error: 'Question not found' });

      // Every module across all of the user's racks, deduped.
      const rackIds = await userModuleIds(db, req.user.id);
      const rack =
        rackIds.length === 0
          ? []
          : await Module.findAll({
              where: { id: rackIds },
              order: [
                ['manufacturer', 'ASC'],
                ['name', 'ASC'],
              ],
            });
      const scopedLinks = await QuestionModule.findAll({ where: { question_id: question.id } });
      const scopedIds = new Set(scopedLinks.map((l) => l.module_id));

      const components =
        rackIds.length === 0
          ? []
          : await ModuleComponent.findAll({
              where: { module_id: rackIds },
              order: [
                ['module_id', 'ASC'],
                ['id', 'ASC'],
              ],
            });
      const componentIds = components.map((c) => c.id);
      const componentIdSet = new Set(componentIds);
      const scopedComponentLinks = await QuestionComponent.findAll({
        where: { question_id: question.id },
      });
      const scopedComponentIds = new Set(scopedComponentLinks.map((l) => l.component_id));

      // Documents visible to this user: shared (auto-found) ones plus their
      // own uploads. Other users' uploads stay invisible.
      const manuals =
        rackIds.length === 0
          ? []
          : await Manual.findAll({
              where: {
                module_id: rackIds,
                [Op.or]: [{ user_id: null }, { user_id: req.user.id }],
              },
              order: [
                ['module_id', 'ASC'],
                ['id', 'ASC'],
              ],
            });

      // Answered questions and notes, each carrying the module and component
      // ids they are linked to so the client can narrow them to the current
      // selection. Link rows are fetched separately (pg-mem-friendly flat
      // queries) and only entries touching the rack are offered.
      const answeredRows = await Question.findAll({
        where: { user_id: req.user.id, status: 'answered', id: { [Op.ne]: question.id } },
        attributes: ['id', 'prompt', 'answered_at'],
        order: [['created_at', 'ASC']],
      });
      const answeredIds = answeredRows.map((q) => q.id);
      const answerModuleLinks =
        answeredIds.length === 0
          ? []
          : await QuestionModule.findAll({ where: { question_id: answeredIds } });
      const answerComponentLinks =
        answeredIds.length === 0
          ? []
          : await QuestionComponent.findAll({ where: { question_id: answeredIds } });
      const groupBy = (links, key, value) => {
        const map = new Map();
        for (const l of links) {
          if (!map.has(l[key])) map.set(l[key], []);
          map.get(l[key]).push(l[value]);
        }
        return map;
      };
      const answerModules = groupBy(answerModuleLinks, 'question_id', 'module_id');
      const answerComponents = groupBy(answerComponentLinks, 'question_id', 'component_id');
      const answers = answeredRows
        .map((q) => ({
          id: q.id,
          prompt: q.prompt,
          answered_at: q.answered_at,
          module_ids: answerModules.get(q.id) ?? [],
          component_ids: answerComponents.get(q.id) ?? [],
        }))
        .filter(
          (a) =>
            a.module_ids.some((id) => scopedIds.has(id) || rackIds.includes(id)) ||
            a.component_ids.some((id) => componentIdSet.has(id))
        );

      const noteRows = await Note.findAll({
        where: { user_id: req.user.id },
        order: [['created_at', 'ASC']],
      });
      const noteIds = noteRows.map((n) => n.id);
      const noteModuleLinks =
        noteIds.length === 0 ? [] : await NoteModule.findAll({ where: { note_id: noteIds } });
      const noteComponentLinks =
        noteIds.length === 0 ? [] : await NoteComponent.findAll({ where: { note_id: noteIds } });
      const noteModules = groupBy(noteModuleLinks, 'note_id', 'module_id');
      const noteComponents = groupBy(noteComponentLinks, 'note_id', 'component_id');
      const notes = noteRows
        .map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          module_ids: noteModules.get(n.id) ?? [],
          component_ids: noteComponents.get(n.id) ?? [],
        }))
        .filter(
          (n) =>
            n.module_ids.some((id) => rackIds.includes(id)) ||
            n.component_ids.some((id) => componentIdSet.has(id))
        );

      // Oscilloscope captures the user has taken, offered like notes: each
      // carries the modules and jacks it is about so the client can narrow
      // them to the current selection.
      const captureRows = await Capture.findAll({
        where: { user_id: req.user.id },
        order: [['id', 'DESC']],
      });
      const captureLinkMap = await captureLinks(captureRows);
      const captures = captureRows
        .map((c) => {
          const links = captureLinkMap.get(c.id) ?? { module_ids: [], component_ids: [], channels: [] };
          return {
            id: c.id,
            title: c.title,
            caption: c.caption,
            patch_id: c.patch_id,
            captured_at: c.captured_at,
            image_hash: c.image_hash,
            channel_count: links.channels.length,
            module_ids: links.module_ids,
            component_ids: links.component_ids,
          };
        })
        .filter(
          (c) =>
            c.module_ids.some((id) => rackIds.includes(id)) ||
            c.component_ids.some((id) => componentIdSet.has(id))
        );

      // The user's patches, each carrying the modules it uses so the client
      // can show which of them the current scope covers. They are all offered
      // whatever the scope: a patch is attached deliberately, and attaching
      // one is how the question becomes a question about that patch.
      const patchRows = await Patch.findAll({
        where: { user_id: req.user.id },
        order: [['created_at', 'DESC']],
      });
      const attachedPatches = await QuestionPatch.findAll({ where: { question_id: question.id } });
      const attachedPatchIds = new Set(attachedPatches.map((l) => l.patch_id));
      const patchModuleIds = await patchModulesByPatch(patchRows.map((p) => p.id));
      const patches = patchRows.map((p) => ({
        id: p.id,
        name: p.name,
        rack_name: p.rack_name,
        created_at: p.created_at,
        attached: attachedPatchIds.has(p.id),
        module_ids: patchModuleIds.get(p.id) ?? [],
      }));

      res.json({
        patches,
        modules: rack.map((m) => ({
          id: m.id,
          manufacturer: m.manufacturer,
          name: m.name,
          in_scope: scopedIds.has(m.id),
        })),
        components: components.map((c) => ({
          id: c.id,
          module_id: c.module_id,
          name: c.name,
          type: c.type,
          in_scope: scopedComponentIds.has(c.id),
        })),
        manuals: manuals.map((m) => ({
          id: m.id,
          module_id: m.module_id,
          name: m.name,
          original_name: m.original_name,
          source: m.source,
        })),
        answers,
        notes,
        captures,
      });
    } catch (e) {
      next(e);
    }
  });

  // Questions are scoped asynchronously by the job worker; the client polls
  // and then presents the review step.
  router.post('/', requireBudget(db), requireLlmAccount(db), async (req, res, next) => {
    try {
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

      // The question and the job that scopes it are created together — a
      // question without its job would sit unscoped forever.
      const question = await db.sequelize.transaction(async (transaction) => {
        const created = await Question.create(
          { user_id: req.user.id, prompt, status: 'scoping' },
          { transaction }
        );
        if (patchIds.length > 0) {
          await QuestionPatch.bulkCreate(
            patchIds.map((id) => ({ question_id: created.id, patch_id: id })),
            { transaction }
          );
        }
        await Job.create(
          {
            type: 'scope_question',
            user_id: req.user.id,
            question_id: created.id,
            status: 'pending',
          },
          { transaction }
        );
        return created;
      });
      res.status(201).json(question);
    } catch (e) {
      next(e);
    }
  });

  // Confirm the review step: save the reviewed module/component scope and
  // attachment selection, then queue the job that answers the question.
  router.post('/:id/answer', requireBudget(db), requireLlmAccount(db), async (req, res, next) => {
    try {
      const question = await Question.findOne({
        where: { id: Number(req.params.id), user_id: req.user.id },
      });
      if (!question) return res.status(404).json({ error: 'Question not found' });
      if (question.status !== 'scoped') {
        return res.status(409).json({ error: 'Question is not awaiting review' });
      }

      const moduleIds = uniqueIds(req.body?.module_ids);
      if (moduleIds.length === 0) {
        return res.status(400).json({ error: 'Select at least one module' });
      }
      const ownedIds = new Set(await userModuleIds(db, req.user.id));
      if (!moduleIds.every((id) => ownedIds.has(id))) {
        return res.status(400).json({ error: 'module_ids must be modules in your racks' });
      }

      const componentIds = uniqueIds(req.body?.component_ids);
      if (componentIds.length > 0) {
        const rows = await ModuleComponent.count({
          where: { id: componentIds, module_id: moduleIds },
        });
        if (rows !== componentIds.length) {
          return res
            .status(400)
            .json({ error: 'component_ids must be components of the selected modules' });
        }
      }

      const manualIds = uniqueIds(req.body?.manual_ids);
      if (manualIds.length > 0) {
        const rows = await Manual.count({
          where: {
            id: manualIds,
            module_id: moduleIds,
            [Op.or]: [{ user_id: null }, { user_id: req.user.id }],
          },
        });
        if (rows !== manualIds.length) {
          return res
            .status(400)
            .json({ error: 'manual_ids must be documents of the selected modules' });
        }
      }

      // Previous answers and notes must be the user's own, and linked to a
      // selected module or a selected component.
      const answerIds = uniqueIds(req.body?.answer_ids);
      if (answerIds.length > 0) {
        const rows = await Question.count({
          where: { id: answerIds, user_id: req.user.id, status: 'answered' },
        });
        if (rows !== answerIds.length) {
          return res.status(400).json({ error: 'answer_ids must be your answered questions' });
        }
        const moduleLinks = await QuestionModule.findAll({
          where: { question_id: answerIds, module_id: moduleIds },
        });
        const componentLinks =
          componentIds.length === 0
            ? []
            : await QuestionComponent.findAll({
                where: { question_id: answerIds, component_id: componentIds },
              });
        const linked = new Set([
          ...moduleLinks.map((l) => l.question_id),
          ...componentLinks.map((l) => l.question_id),
        ]);
        if (linked.size !== answerIds.length) {
          return res.status(400).json({
            error: 'answer_ids must be answers about the selected modules or components',
          });
        }
      }

      const noteIds = uniqueIds(req.body?.note_ids);
      if (noteIds.length > 0) {
        const rows = await Note.count({ where: { id: noteIds, user_id: req.user.id } });
        if (rows !== noteIds.length) {
          return res.status(400).json({ error: 'note_ids must be your notes' });
        }
        const moduleLinks = await NoteModule.findAll({
          where: { note_id: noteIds, module_id: moduleIds },
        });
        const componentLinks =
          componentIds.length === 0
            ? []
            : await NoteComponent.findAll({
                where: { note_id: noteIds, component_id: componentIds },
              });
        const linked = new Set([
          ...moduleLinks.map((l) => l.note_id),
          ...componentLinks.map((l) => l.note_id),
        ]);
        if (linked.size !== noteIds.length) {
          return res.status(400).json({
            error: 'note_ids must be notes attached to the selected modules or components',
          });
        }
      }

      const captureIds = uniqueIds(req.body?.capture_ids);
      if (captureIds.length > 0) {
        const rows = await Capture.findAll({
          where: { id: captureIds, user_id: req.user.id },
        });
        if (rows.length !== captureIds.length) {
          return res.status(400).json({ error: 'capture_ids must be your captures' });
        }
        const links = await captureLinks(rows);
        const selectedModules = new Set(moduleIds);
        const selectedComponents = new Set(componentIds);
        const unrelated = rows.find((c) => {
          const link = links.get(c.id);
          return (
            !link.module_ids.some((id) => selectedModules.has(id)) &&
            !link.component_ids.some((id) => selectedComponents.has(id))
          );
        });
        if (unrelated) {
          return res.status(400).json({
            error: 'capture_ids must be captures of the selected modules or components',
          });
        }
      }

      // Patches are the user's own; unlike notes and captures they are not
      // narrowed to the selected modules — attaching a patch is what makes
      // the question a question about that patch.
      const patchIds = uniqueIds(req.body?.patch_ids);
      if (patchIds.length > 0) {
        const rows = await Patch.count({ where: { id: patchIds, user_id: req.user.id } });
        if (rows !== patchIds.length) {
          return res.status(400).json({ error: 'patch_ids must be your patches' });
        }
      }

      if (
        manualIds.length + answerIds.length + noteIds.length + captureIds.length + patchIds.length ===
        0
      ) {
        return res.status(400).json({
          error: 'Attach at least one document (manual, previous answer, note, capture, or patch)',
        });
      }

      await db.sequelize.transaction(async (transaction) => {
        await QuestionModule.destroy({ where: { question_id: question.id }, transaction });
        await QuestionModule.bulkCreate(
          moduleIds.map((id) => ({ question_id: question.id, module_id: id })),
          { transaction }
        );
        await QuestionComponent.destroy({ where: { question_id: question.id }, transaction });
        if (componentIds.length > 0) {
          await QuestionComponent.bulkCreate(
            componentIds.map((id) => ({ question_id: question.id, component_id: id })),
            { transaction }
          );
        }
        await QuestionManual.destroy({ where: { question_id: question.id }, transaction });
        if (manualIds.length > 0) {
          await QuestionManual.bulkCreate(
            manualIds.map((id) => ({ question_id: question.id, manual_id: id })),
            { transaction }
          );
        }
        await QuestionAnswer.destroy({ where: { question_id: question.id }, transaction });
        if (answerIds.length > 0) {
          await QuestionAnswer.bulkCreate(
            answerIds.map((id) => ({ question_id: question.id, source_question_id: id })),
            { transaction }
          );
        }
        await QuestionNote.destroy({ where: { question_id: question.id }, transaction });
        if (noteIds.length > 0) {
          await QuestionNote.bulkCreate(
            noteIds.map((id) => ({ question_id: question.id, note_id: id })),
            { transaction }
          );
        }
        await QuestionCapture.destroy({ where: { question_id: question.id }, transaction });
        if (captureIds.length > 0) {
          await QuestionCapture.bulkCreate(
            captureIds.map((id) => ({ question_id: question.id, capture_id: id })),
            { transaction }
          );
        }
        await QuestionPatch.destroy({ where: { question_id: question.id }, transaction });
        if (patchIds.length > 0) {
          await QuestionPatch.bulkCreate(
            patchIds.map((id) => ({ question_id: question.id, patch_id: id })),
            { transaction }
          );
        }

        await Question.update(
          { status: 'pending', error: null },
          { where: { id: question.id }, transaction }
        );
        await Job.create(
          {
            type: 'answer_question',
            user_id: req.user.id,
            question_id: question.id,
            status: 'pending',
          },
          { transaction }
        );
      });

      const updated = await Question.findByPk(question.id);
      res.json(updated.get({ plain: true }));
    } catch (e) {
      next(e);
    }
  });

  // Deleting a question takes all of its records with it via the schema's
  // ON DELETE CASCADE rules: scope links, attachment selections, its own
  // jobs, and any question_answers rows citing it as a source (the citing
  // questions themselves are untouched).
  router.delete('/:id', async (req, res, next) => {
    try {
      const question = await Question.findOne({
        where: { id: Number(req.params.id), user_id: req.user.id },
      });
      if (!question) return res.status(404).json({ error: 'Question not found' });
      await question.destroy();
      await removeShares(db, 'question', question.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
