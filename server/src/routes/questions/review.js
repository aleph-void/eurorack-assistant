// The review step: what a user may attach to a scoped question, and
// confirming the selection.
//
// GET /:id/options offers their whole rack and its components (flagging what
// the scoping model picked) plus manual documents, previously answered
// questions, notes, patches and oscilloscope captures. POST /:id/answer
// saves what came back — checking every id against what was on offer — and
// queues the answer_question job.

import { Router } from 'express';
import { Op } from 'sequelize';
import { userModuleIds } from '../../services/racks.js';
import { requireBudget } from '../../services/budgets.js';
import { requireLlmAccount } from '../../services/llmAccounts.js';
import { asyncHandler } from '../asyncHandler.js';
import { audioJson } from '../../services/audio.js';
import { audioLinks, captureLinks, patchModulesByPatch, uniqueIds } from './helpers.js';

export function questionReviewRoutes(db) {
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
    Patch,
    Module,
    ModuleComponent,
    Manual,
    Note,
    NoteModule,
    NoteComponent,
    Capture,
    AudioRecording,
    Job,
  } = db.models;
  const router = Router();

  // Everything the user can select in the review step: their whole rack and
  // its components (flagging what the LLM scoped in), plus manual documents,
  // previously answered questions, and notes — the latter two linkable via
  // either a module or a specific component.
  router.get('/:id/options', asyncHandler(async (req, res) => {
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
    const captureLinkMap = await captureLinks(db, captureRows);
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

    // Recordings of the selected modules, or of a patch that uses them.
    // A recording is offered on the same terms as a capture — it is about a
    // module, so it is offered where that module is — and it travels to the
    // model as the picture drawn from it plus the levels measured off it.
    const audioRows = await AudioRecording.findAll({
      where: { user_id: req.user.id },
      order: [['id', 'DESC']],
    });
    const audioLinkMap = await audioLinks(db, audioRows);
    const audio = audioRows
      .map((row) => {
        const links = audioLinkMap.get(row.id) ?? { module_ids: [] };
        return { ...audioJson(row), module_ids: links.module_ids };
      })
      .filter((a) => a.module_ids.some((id) => rackIds.includes(id)));

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
    const patchModuleIds = await patchModulesByPatch(db, patchRows.map((p) => p.id));
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
      audio,
    });
  }));

  // Confirm the review step: save the reviewed module/component scope and
  // attachment selection, then queue the job that answers the question.
  router.post('/:id/answer', requireBudget(db), requireLlmAccount(db), asyncHandler(async (req, res) => {
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
      const links = await captureLinks(db, rows);
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

    const audioIds = uniqueIds(req.body?.audio_ids);
    if (audioIds.length > 0) {
      const rows = await AudioRecording.findAll({
        where: { id: audioIds, user_id: req.user.id },
      });
      if (rows.length !== audioIds.length) {
        return res.status(400).json({ error: 'audio_ids must be your recordings' });
      }
      const links = await audioLinks(db, rows);
      const selectedModules = new Set(moduleIds);
      const unrelated = rows.find(
        (row) => !links.get(row.id).module_ids.some((id) => selectedModules.has(id))
      );
      if (unrelated) {
        return res
          .status(400)
          .json({ error: 'audio_ids must be recordings of the selected modules' });
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
      manualIds.length +
        answerIds.length +
        noteIds.length +
        captureIds.length +
        audioIds.length +
        patchIds.length ===
      0
    ) {
      return res.status(400).json({
        error:
          'Attach at least one document (manual, previous answer, note, capture, recording, or patch)',
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
      await QuestionAudio.destroy({ where: { question_id: question.id }, transaction });
      if (audioIds.length > 0) {
        await QuestionAudio.bulkCreate(
          audioIds.map((id) => ({ question_id: question.id, audio_id: id })),
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
  }));

  return router;
}
