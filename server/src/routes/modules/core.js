import fs from 'node:fs';
import { Router } from 'express';
import { Op, col, fn, where } from 'sequelize';
import { manualPath } from '../../services/pdf.js';
import { isCompanionDocumentName, isRetailerPageName } from '../../services/manualFinder.js';
import { normalizeHp } from '../../services/panelImage.js';
import { enqueueExtractManual, enqueueModuleJob } from '../../jobs/worker.js';
import { removeShares } from '../../services/sharing.js';
import { requireBudget } from '../../services/budgets.js';
import { requireOwnedModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// Module-level routes: the rack-scoped module list, the pipeline gap-filler,
// per-module re-analysis, basic-fact edits and removal from racks.
export function moduleCoreRoutes(db, { manualsDir }) {
  const {
    Module,
    Rack,
    RackModule,
    ModuleComponent,
    ModulePanel,
    Manual,
    ManualDocument,
    Note,
    NoteModule,
    NoteComponent,
  } = db.models;
  const router = Router();

  // The user's modules, either across all their racks (deduped, quantities
  // summed) or filtered to one rack via ?rack_id=. Each entry carries its
  // per-rack placements.
  router.get('/', asyncHandler(async (req, res) => {
    const rackWhere = { user_id: req.user.id };
    if (req.query.rack_id) {
      const rack = await Rack.findOne({
        where: { id: Number(req.query.rack_id), user_id: req.user.id },
      });
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      rackWhere.id = rack.id;
    }
    const mappings = await RackModule.findAll({
      include: [{ model: Rack, where: rackWhere }, Module],
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
        [Rack, 'name', 'ASC'],
      ],
    });
    const byModule = new Map();
    for (const rm of mappings) {
      const m = rm.Module;
      if (!byModule.has(m.id)) {
        byModule.set(m.id, {
          id: m.id,
          manufacturer: m.manufacturer,
          name: m.name,
          quantity: 0,
          racks: [],
          manual_status: m.manual_status,
          analysis_status: m.analysis_status,
          panel_status: m.panel_status,
          hp: m.hp,
          summary: m.summary,
          created_at: m.created_at,
          updated_at: m.updated_at,
        });
      }
      const entry = byModule.get(m.id);
      entry.quantity += rm.quantity;
      entry.racks.push({ id: rm.Rack.id, name: rm.Rack.name, quantity: rm.quantity });
    }
    res.json([...byModule.values()]);
  }));

  // Fill in what the pipeline never managed to work out, across a whole
  // system. Runs which are needed rather than everything: a module whose
  // manual was never found, whose analysis produced no components, or which
  // has no front panel picture or HP width gets the one job that would
  // supply the gap, and a module that already has all of it is left alone.
  // Redoing complete work costs a model run per module and overwrites
  // corrections made by hand, so it is not the default.
  //
  // Body: { rack_id?, rediscover_manuals?: boolean, rebuild_panels?: boolean }.
  // Re-discovery is off by default: a module missing its analysis usually has
  // a usable manual on disk already, and searching for it again costs a web
  // search. Turning it on sends those modules back to the search first — the
  // escape hatch for a module whose manual turned out to be the wrong
  // document. A module with no manual at all is sent to find one either way,
  // since there is nothing else for it to be analyzed from.
  //
  // rebuild_panels is the same escape hatch for the panels: every analyzed
  // module goes back through the panel step even if it already has one. The
  // one thing that reliably wants it is a change to how panels are built —
  // the positions on an existing panel were worked out by the code as it was
  // then, and nothing about the module itself says they are out of date. A
  // panel picture someone uploaded survives it: that job keeps the image and
  // only works the markers out again (services/panelImage.js).
  //
  // The jobs chain (find_manual → analyze_manual → panel_image), so filling
  // an early gap fills the later ones behind it without queueing them here.
  router.post('/reanalyze', requireBudget(db), asyncHandler(async (req, res) => {
    const rackWhere = { user_id: req.user.id };
    if (req.body?.rack_id) {
      const rack = await Rack.findOne({
        where: { id: Number(req.body.rack_id), user_id: req.user.id },
      });
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      rackWhere.id = rack.id;
    }
    const mappings = await RackModule.findAll({
      include: [{ model: Rack, where: rackWhere }, Module],
      order: [[Module, 'id', 'ASC']],
    });
    const modules = [...new Map(mappings.map((rm) => [rm.Module.id, rm.Module])).values()];
    const rediscover = Boolean(req.body?.rediscover_manuals);
    const rebuildPanels = Boolean(req.body?.rebuild_panels);
    const moduleIds = modules.map((m) => m.id);

    const [manuals, components, panels, documents] =
      moduleIds.length === 0
        ? [[], [], [], []]
        : await Promise.all([
            Manual.findAll({
              where: { module_id: moduleIds, user_id: null },
              attributes: ['id', 'module_id', 'user_id', 'hash'],
            }),
            ModuleComponent.findAll({ where: { module_id: moduleIds }, attributes: ['module_id'] }),
            ModulePanel.findAll({ where: { module_id: moduleIds }, attributes: ['module_id'] }),
            ManualDocument.findAll({
              where: { module_id: moduleIds },
              attributes: ['manual_id'],
            }),
          ]);
    const hasManual = new Set(manuals.map((m) => m.module_id));
    const hasText = new Set(documents.map((d) => d.manual_id));
    const hasComponents = new Set(components.map((c) => c.module_id));
    const hasPanel = new Set(panels.map((p) => p.module_id));

    // The earliest incomplete step of the pipeline, or null when the module
    // has everything. A missing HP is the panel step's business: both the
    // analysis and the panel job record it, but the panel job is the one
    // that researches a width when the manual never states it.
    function missingStep(module) {
      if (!hasManual.has(module.id)) return 'find_manual';
      if (!hasComponents.has(module.id) || !module.summary) return 'analyze_manual';
      if (rebuildPanels || !hasPanel.has(module.id) || module.hp == null) return 'panel_image';
      return null;
    }

    const queued = { find_manual: 0, analyze_manual: 0, panel_image: 0, extract_manual: 0 };
    let skipped = 0;
    let complete = 0;
    // A manual that was found before the app extracted text (or whose
    // extraction failed) has a PDF and no markdown. That gap is filled on
    // its own: the extraction needs nothing from the analysis or the panel,
    // so it does not wait behind them and does not count as the module's
    // missing step.
    const sharedManuals = new Map(manuals.map((m) => [m.module_id, m]));
    for (const module of modules) {
      const manual = sharedManuals.get(module.id);
      if (manual && !hasText.has(manual.id)) {
        if (await enqueueExtractManual(db, manual.get({ plain: true }), req.user.id)) {
          queued.extract_manual += 1;
        }
      }
    }
    for (const module of modules) {
      const step = missingStep(module);
      if (!step) {
        complete += 1;
        continue;
      }
      const type = rediscover && step === 'analyze_manual' ? 'find_manual' : step;
      // A module already queued for (or in the middle of) that job is left
      // alone rather than made to do the work twice.
      if (!(await enqueueModuleJob(db, type, module, req.user.id))) {
        skipped += 1;
        continue;
      }
      queued[type] += 1;
      const statuses = {
        find_manual: { manual_status: 'pending', analysis_status: 'pending' },
        analyze_manual: { analysis_status: 'pending' },
        panel_image: { panel_status: 'pending' },
      };
      await Module.update(statuses[type], { where: { id: module.id } });
    }
    res.json({ modules: modules.length, queued, skipped, complete });
  }));

  // Re-analyze ONE module's components with retailer product pages fetched
  // fresh: the job downloads the module's page from Perfect Circuit, Detroit
  // Modular and Midwest Modular, saves whichever it finds marked in scope
  // for analysis, and submits the manual together with every in-scope
  // document. Refused while any of those pages already exists for the module —
  // the GUI disables its button on the same test — because the fetch is what
  // this action is for, and rendered pages would otherwise pile up.
  router.post('/:id/reanalyze', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const shared = await Manual.findAll({
      where: { module_id: module.id, user_id: null },
      attributes: ['id', 'original_name'],
    });
    if (!shared.some((m) => !isCompanionDocumentName(m.original_name))) {
      return res.status(409).json({ error: 'This module has no manual to re-analyze from' });
    }
    const existing = shared.filter((m) => isRetailerPageName(m.original_name));
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Retailer product pages already exist for this module',
        documents: existing.map((m) => m.original_name),
      });
    }
    const job = await enqueueModuleJob(db, 'reanalyze_components', module, req.user.id);
    if (!job) {
      return res.status(409).json({ error: 'A re-analysis is already queued for this module' });
    }
    await Module.update({ analysis_status: 'pending' }, { where: { id: module.id } });
    res.status(202).json({ job_id: job.id });
  }));

  // Rebuild ONE module's manual analysis from the documents it already has:
  // the shared manual is submitted again, together with every document
  // marked in scope for analysis (vendor pages arrive marked; the user can
  // mark or unmark any document on the module page). Nothing is fetched —
  // this is the counterpart to /reanalyze for modules whose vendor pages are
  // already on disk, or for simply re-running a bad analysis.
  router.post('/:id/analyze', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const shared = await Manual.findAll({
      where: { module_id: module.id, user_id: null },
      attributes: ['id', 'original_name'],
    });
    if (!shared.some((m) => !isCompanionDocumentName(m.original_name))) {
      return res.status(409).json({ error: 'This module has no manual to analyze' });
    }
    const job = await enqueueModuleJob(db, 'analyze_manual', module, req.user.id, {
      rebuild: true,
    });
    if (!job) {
      return res.status(409).json({ error: 'An analysis is already queued for this module' });
    }
    await Module.update({ analysis_status: 'pending' }, { where: { id: module.id } });
    res.status(202).json({ job_id: job.id });
  }));

  // Correct a module's basic facts. Body: { manufacturer?, name?, hp? } — at
  // least one. Like components, these are shared hardware facts: any user who
  // has the module racked may fix them, and the fix shows for every user
  // sharing the record. No re-analysis is triggered. Imports dedupe modules
  // case-insensitively on manufacturer + name, so a rename that collides with
  // another module is refused rather than creating two records that later
  // imports could not tell apart.
  router.patch('/:id', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const fields = {};
    for (const key of ['manufacturer', 'name']) {
      if (req.body?.[key] === undefined) continue;
      const value = String(req.body[key]).trim();
      if (!value) return res.status(400).json({ error: `${key} cannot be empty` });
      fields[key] = value;
    }
    if (req.body?.hp !== undefined) {
      const raw = req.body.hp;
      if (raw === null || String(raw).trim() === '') {
        fields.hp = null;
      } else {
        const hp = normalizeHp(raw);
        if (hp === null) return res.status(400).json({ error: 'hp must be a positive number' });
        fields.hp = hp;
      }
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Send manufacturer, name and/or hp to update' });
    }
    if (fields.manufacturer !== undefined || fields.name !== undefined) {
      const manufacturer = fields.manufacturer ?? module.manufacturer;
      const name = fields.name ?? module.name;
      const clash = await Module.findOne({
        where: {
          [Op.and]: [
            where(fn('lower', col('manufacturer')), manufacturer.toLowerCase()),
            where(fn('lower', col('name')), name.toLowerCase()),
            { id: { [Op.ne]: module.id } },
          ],
        },
      });
      if (clash) {
        return res
          .status(409)
          .json({ error: `A module named "${manufacturer} ${name}" already exists` });
      }
    }
    await Module.update(fields, { where: { id: module.id } });
    res.json({ ...module, ...fields });
  }));

  // Removing a module removes it from *your* racks (one rack when ?rack_id=
  // is given, otherwise all of them) and nothing more. The module record
  // itself is kept even once it is in no rack at all: its manual, analysis,
  // panel and components are shared hardware facts that cost model runs to
  // produce, so importing the same manufacturer + name again — by you or by
  // another user — picks the finished record back up instead of rebuilding
  // it. Your questions and notes about it stay too, and come back with it.
  // Removing a module is a disassociation, never a deletion of the shared
  // record: the module and its found manual are hardware facts that belong to
  // everyone who has it racked, so they stay. What goes is this user's tie to
  // it (the rack membership) and — once the module is in none of their racks —
  // the private data they built around it: their notes, their questions and
  // answers, and any manual they uploaded themselves. Another user's racks,
  // notes, questions and uploads are untouched.
  async function cleanupUserModuleData(userId, moduleId, transaction) {
    const {
      Question,
      QuestionModule,
      QuestionComponent,
    } = db.models;

    const componentIds = (
      await ModuleComponent.findAll({
        where: { module_id: moduleId },
        attributes: ['id'],
        transaction,
      })
    ).map((c) => c.id);

    // Resolve "this user's records that reference the module (directly, or via
    // one of its components)" by intersecting in JS — the OR that would express
    // it in one query is exactly what pg-mem mishandles (see helpers.js).
    const ownNoteIds = new Set(
      (await Note.findAll({ where: { user_id: userId }, attributes: ['id'], transaction })).map(
        (n) => n.id
      )
    );
    const linkedNoteIds = new Set(
      (await NoteModule.findAll({ where: { module_id: moduleId }, transaction })).map(
        (l) => l.note_id
      )
    );
    if (componentIds.length) {
      for (const l of await NoteComponent.findAll({
        where: { component_id: componentIds },
        transaction,
      })) {
        linkedNoteIds.add(l.note_id);
      }
    }
    const noteIds = [...linkedNoteIds].filter((id) => ownNoteIds.has(id));

    const ownQuestionIds = new Set(
      (await Question.findAll({ where: { user_id: userId }, attributes: ['id'], transaction })).map(
        (q) => q.id
      )
    );
    const linkedQuestionIds = new Set(
      (await QuestionModule.findAll({ where: { module_id: moduleId }, transaction })).map(
        (l) => l.question_id
      )
    );
    if (componentIds.length) {
      for (const l of await QuestionComponent.findAll({
        where: { component_id: componentIds },
        transaction,
      })) {
        linkedQuestionIds.add(l.question_id);
      }
    }
    const questionIds = [...linkedQuestionIds].filter((id) => ownQuestionIds.has(id));

    // The user's own uploaded manuals for this module (never the shared
    // found manual, which has a null user_id).
    const manuals = await Manual.findAll({
      where: { module_id: moduleId, user_id: userId },
      transaction,
    });

    // Deleting a note/question/manual row cascades its link and document rows
    // (FK ON DELETE CASCADE); the share rows that point at it do not, so they
    // are cleared explicitly, exactly as the dedicated delete routes do.
    for (const id of noteIds) {
      await Note.destroy({ where: { id }, transaction });
      await removeShares(db, 'note', id, { transaction });
    }
    for (const id of questionIds) {
      await Question.destroy({ where: { id }, transaction });
      await removeShares(db, 'question', id, { transaction });
    }
    const hashes = [];
    for (const manual of manuals) {
      await manual.destroy({ transaction });
      await removeShares(db, 'document', manual.id, { transaction });
      hashes.push(manual.hash);
    }
    return { hashes, counts: { notes: noteIds.length, questions: questionIds.length, manuals: manuals.length } };
  }

  router.delete('/:id', asyncHandler(async (req, res) => {
    const moduleId = Number(req.params.id);
    const rackWhere = { user_id: req.user.id };
    if (req.query.rack_id) rackWhere.id = Number(req.query.rack_id);
    const racks = await Rack.findAll({ where: rackWhere });
    const deleted =
      racks.length === 0
        ? 0
        : await RackModule.destroy({
            where: { rack_id: racks.map((r) => r.id), module_id: moduleId },
          });
    if (deleted === 0) return res.status(404).json({ error: 'Module not found' });

    // Only tear down the private data once the module has left every one of
    // the user's racks — removing it from one rack while it sits in another
    // keeps the notes and questions relevant.
    const ownRackIds = (
      await Rack.findAll({ where: { user_id: req.user.id }, attributes: ['id'] })
    ).map((r) => r.id);
    const stillRacked = ownRackIds.length
      ? await RackModule.count({ where: { module_id: moduleId, rack_id: ownRackIds } })
      : 0;

    let cleanup = null;
    if (stillRacked === 0) {
      cleanup = await db.sequelize.transaction((transaction) =>
        cleanupUserModuleData(req.user.id, moduleId, transaction)
      );
      // Remove uploaded PDFs whose last reference just went away. The file is
      // shared by every manual row with the same hash, so re-count first.
      for (const hash of cleanup.hashes) {
        const remaining = await Manual.count({ where: { hash } });
        if (remaining === 0) fs.rmSync(manualPath(manualsDir, hash), { force: true });
      }
    }
    res.json({ ok: true, ...(cleanup ? { removed: cleanup.counts } : {}) });
  }));

  return router;
}
