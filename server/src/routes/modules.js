import fs from 'node:fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { isProbablyPdfBuffer, manualPath, sha256Buffer } from '../services/pdf.js';
import {
  normalizationKind,
  COMPONENT_TYPES,
  VALUE_TYPES,
  PORT_KINDS,
  BREAK_MODES,
} from '../services/manualAnalyzer.js';
import { deleteModulesDeep } from '../services/moduleDeletion.js';
import { refreshModuleLinks, unlinkedExpanderHints } from '../services/moduleLinks.js';
import { loadPanels } from '../services/panelImage.js';
import { enqueueModuleJob } from '../jobs/worker.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function moduleRoutes(
  db,
  {
    manualsDir = process.env.MANUALS_DIR || '/data/manuals',
    panelsDir = process.env.PANELS_DIR || '/data/panels',
  } = {}
) {
  const {
    Module,
    Rack,
    RackModule,
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentValue,
    ComponentPair,
    ModuleExpander,
    Manual,
    Note,
    NoteModule,
    NoteComponent,
  } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // The modules whose components this module's signal paths may reference:
  // itself, plus any expander declared on it (and any host that declares it
  // as an expander). An expander is wired to its host by a ribbon cable, so
  // the pair's internal signal paths cross between the two panels.
  async function linkedModuleIds(moduleId) {
    const rows = await ModuleExpander.findAll({
      where: { [Op.or]: [{ host_module_id: moduleId }, { expander_module_id: moduleId }] },
    });
    const ids = new Set([moduleId]);
    for (const row of rows) {
      ids.add(row.host_module_id);
      ids.add(row.expander_module_id);
    }
    return [...ids];
  }

  // Find a component on the module or on one of its linked panels.
  async function linkedComponent(moduleId, componentId) {
    if (!Number(componentId)) return null;
    return ModuleComponent.findOne({
      where: { id: Number(componentId), module_id: await linkedModuleIds(moduleId) },
    });
  }

  // The condition on a route or normalization: the control position that path
  // depends on. Body fields condition_component_id + condition_value (both or
  // neither), plus a free-text alt_group tying alternatives together.
  async function readCondition(module, body) {
    const rawId = body?.condition_component_id;
    const rawValue = String(body?.condition_value ?? '').trim();
    const altGroup = String(body?.alt_group ?? '').trim() || null;
    if (rawId === undefined || rawId === null || rawId === '') {
      if (rawValue) {
        return { error: 'condition_value needs a condition_component_id' };
      }
      return { fields: { condition_component_id: null, condition_value: null, alt_group: altGroup } };
    }
    const control = await linkedComponent(module.id, rawId);
    if (!control) {
      return { error: 'condition_component_id must be a component of this module' };
    }
    if (control.type.endsWith('_jack')) {
      return { error: 'a condition names a control (a switch, knob or toggle), not a jack' };
    }
    if (!rawValue) return { error: 'condition_value is required with condition_component_id' };
    return {
      fields: { condition_component_id: control.id, condition_value: rawValue, alt_group: altGroup },
    };
  }

  // The user's rack mappings for a module (across all their racks), or null
  // if it isn't in any of them. Returns the module plus its per-rack
  // placements and the total quantity.
  async function userModule(userId, moduleId) {
    const mappings = await RackModule.findAll({
      where: { module_id: Number(moduleId) },
      include: [{ model: Rack, where: { user_id: userId } }, Module],
      order: [[Rack, 'name', 'ASC']],
    });
    if (mappings.length === 0 || !mappings[0].Module) return null;
    return {
      ...mappings[0].Module.get({ plain: true }),
      quantity: mappings.reduce((sum, rm) => sum + rm.quantity, 0),
      racks: mappings.map((rm) => ({
        id: rm.Rack.id,
        name: rm.Rack.name,
        quantity: rm.quantity,
      })),
    };
  }

  // The user's modules, either across all their racks (deduped, quantities
  // summed) or filtered to one rack via ?rack_id=. Each entry carries its
  // per-rack placements.
  router.get('/', async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // Re-run the manual analysis across a whole system. The analysis prompt
  // gains fields as the app learns to record more about a module (signal
  // paths, switch sections, panel layout), and every module analyzed before
  // that is missing them — so "analyze everything again" is a maintenance
  // action rather than a per-module chore.
  //
  // Body: { rack_id?, rediscover_manuals?: boolean }. Re-discovery is off by
  // default: the manuals are already on disk, finding them again costs a web
  // search per module, and an unchanged manual dedupes to the same file
  // anyway. A module with no manual at all is sent to find one regardless —
  // there is nothing else for it to be analyzed from.
  router.post('/reanalyze', async (req, res, next) => {
    try {
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

      const manuals =
        modules.length === 0
          ? []
          : await Manual.findAll({
              where: { module_id: modules.map((m) => m.id), user_id: null },
              attributes: ['module_id'],
            });
      const hasManual = new Set(manuals.map((m) => m.module_id));

      const queued = { find_manual: 0, analyze_manual: 0 };
      let skipped = 0;
      for (const module of modules) {
        const type = rediscover || !hasManual.has(module.id) ? 'find_manual' : 'analyze_manual';
        // A module already queued for (or in the middle of) that job is left
        // alone rather than made to do the work twice.
        if (!(await enqueueModuleJob(db, type, module, req.user.id))) {
          skipped += 1;
          continue;
        }
        queued[type] += 1;
        await Module.update(
          type === 'find_manual'
            ? { manual_status: 'pending', analysis_status: 'pending' }
            : { analysis_status: 'pending' },
          { where: { id: module.id } }
        );
      }
      res.json({ modules: modules.length, queued, skipped });
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const components = await ModuleComponent.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'type',
          'name',
          'description',
          'voltage_min',
          'voltage_max',
          'polarity',
          'group_label',
          'port_kind',
        ],
        order: [
          ['type', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      // Each component's valid values ('min'/'max' range ends or 'enum'
      // positions), grouped in JS (pg-mem-friendly flat query).
      const valueRows =
        components.length === 0
          ? []
          : await ComponentValue.findAll({
              where: { component_id: components.map((c) => c.id) },
              attributes: ['id', 'component_id', 'type', 'value', 'description'],
              order: [['id', 'ASC']],
            });
      const valuesByComponent = new Map();
      for (const v of valueRows) {
        if (!valuesByComponent.has(v.component_id)) valuesByComponent.set(v.component_id, []);
        valuesByComponent.get(v.component_id).push({
          id: v.id,
          type: v.type,
          value: v.value,
          description: v.description,
        });
      }
      const componentsJson = components.map((c) => ({
        ...c.get({ plain: true }),
        values: valuesByComponent.get(c.id) ?? [],
      }));
      // Normalled connections between the module's components (from the
      // manual analysis); target/source ids reference the components above.
      const normalizations = await ComponentNormalization.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'target_component_id',
          'source_component_id',
          'source_label',
          'kind',
          'condition_component_id',
          'condition_value',
          'alt_group',
          'break_component_id',
          'break_on',
          'description',
        ],
        order: [['id', 'ASC']],
      });
      // Internal signal paths (input jack → output jack); output jacks that
      // appear in no route are signal generators.
      const routes = await ComponentRoute.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'input_component_id',
          'output_component_id',
          'condition_component_id',
          'condition_value',
          'alt_group',
          'description',
        ],
        order: [['id', 'ASC']],
      });
      // Jacks that carry the two halves of one signal (a stereo L/R pair).
      const pairs = await ComponentPair.findAll({
        where: { module_id: module.id },
        attributes: ['id', 'a_component_id', 'b_component_id', 'kind', 'description'],
        order: [['id', 'ASC']],
      });
      // Expander panels wired to this module (and hosts it expands): their
      // jacks may appear at either end of this module's signal paths.
      const expanderRows = await ModuleExpander.findAll({
        where: { [Op.or]: [{ host_module_id: module.id }, { expander_module_id: module.id }] },
        order: [['id', 'ASC']],
      });
      const partnerIds = expanderRows.map((e) =>
        e.host_module_id === module.id ? e.expander_module_id : e.host_module_id
      );
      const partners = partnerIds.length
        ? await Module.findAll({
            where: { id: partnerIds },
            attributes: ['id', 'manufacturer', 'name'],
          })
        : [];
      const partnerById = new Map(partners.map((m) => [m.id, m]));
      const expanders = expanderRows.map((e) => {
        const isHost = e.host_module_id === module.id;
        const partner = partnerById.get(isHost ? e.expander_module_id : e.host_module_id);
        return {
          id: e.id,
          // 'expander' — the partner expands this module; 'host' — this
          // module is the expander and the partner is its host.
          role: isHost ? 'expander' : 'host',
          module_id: partner?.id ?? null,
          manufacturer: partner?.manufacturer ?? null,
          name: partner?.name ?? null,
          description: e.description,
        };
      });
      // The components of those panels, so the GUI can offer them when
      // recording a signal path that crosses the ribbon cable.
      const partnerComponents = partnerIds.length
        ? await ModuleComponent.findAll({
            where: { module_id: partnerIds },
            attributes: ['id', 'module_id', 'type', 'name', 'group_label', 'port_kind'],
            order: [['id', 'ASC']],
          })
        : [];
      // Routing switch sections (common jack ↔ one step jack at a time).
      const switchRows = await ComponentSwitch.findAll({
        where: { module_id: module.id },
        order: [['id', 'ASC']],
      });
      const switchSteps =
        switchRows.length === 0
          ? []
          : await ComponentSwitchStep.findAll({
              where: { switch_id: switchRows.map((s) => s.id) },
              order: [
                ['position', 'ASC'],
                ['component_id', 'ASC'],
              ],
            });
      const switches = switchRows.map((s) => ({
        id: s.id,
        name: s.name,
        common_component_id: s.common_component_id,
        step_component_ids: switchSteps
          .filter((st) => st.switch_id === s.id)
          .map((st) => st.component_id),
        description: s.description,
      }));
      // Documents: the shared auto-found manual plus this user's own uploads.
      const manuals = await Manual.findAll({
        where: {
          module_id: module.id,
          [Op.or]: [{ user_id: null }, { user_id: req.user.id }],
        },
        attributes: ['id', 'hash', 'name', 'original_name', 'source', 'user_id', 'created_at'],
        order: [['id', 'ASC']],
      });
      // The requesting user's notes attached to this module (component_id NULL)
      // or to one of its components. Notes are strictly private per user.
      const moduleNotes = await NoteModule.findAll({
        where: { module_id: module.id },
        include: [{ model: Note, where: { user_id: req.user.id } }],
        order: [[Note, 'id', 'ASC']],
      });
      const componentNotes = await NoteComponent.findAll({
        include: [
          { model: Note, where: { user_id: req.user.id } },
          { model: ModuleComponent, where: { module_id: module.id }, attributes: [] },
        ],
        order: [[Note, 'id', 'ASC']],
      });
      const noteJson = (note, componentId) => ({
        id: note.id,
        title: note.title,
        body: note.body,
        updated_at: note.updated_at,
        component_id: componentId,
      });
      // The front plate and where each component sits on it, so the module
      // page can show the picture the patch diagram draws from.
      const panels = await loadPanels(db, [module.id]);
      res.json({
        ...module,
        panel: panels.get(module.id) ?? null,
        components: componentsJson,
        normalizations,
        routes,
        switches,
        pairs,
        expanders,
        expander_components: partnerComponents,
        // Panels this module's manual named that are not linked to a module
        // record — usually because the expander has not been imported yet.
        expander_suggestions: await unlinkedExpanderHints(db, module),
        manuals,
        notes: [
          ...moduleNotes.map((nm) => noteJson(nm.Note, null)),
          ...componentNotes.map((nc) => noteJson(nc.Note, nc.component_id)),
        ],
      });
    } catch (e) {
      next(e);
    }
  });

  // Removing a module removes it from *your* racks (one rack when ?rack_id=
  // is given, otherwise all of them). Once a module is left in no rack at
  // all, the module record itself is fully deleted — components, manuals,
  // and *your* questions and notes about it included (other users' stay).
  // While another user still has it racked, the shared record survives.
  router.delete('/:id', async (req, res, next) => {
    try {
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
      if ((await RackModule.count({ where: { module_id: moduleId } })) === 0) {
        await deleteModulesDeep(db, req.user.id, [moduleId], { manualsDir, panelsDir });
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Manually record a normalled connection the analysis missed. Body:
  // { target_component_id, source_component_id | source_label, description }.
  // Like components, normalizations are shared hardware facts: any user who
  // has the module racked may correct them, and a re-analysis replaces manual
  // rows along with the analyzed ones. kind is derived from the source.
  router.post('/:id/normalizations', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const {
        target_component_id: targetId,
        source_component_id: sourceId,
        source_label: rawLabel,
        break_component_id: breakId,
        break_on: rawBreakOn,
        description: rawDescription,
      } = req.body || {};

      const target = await linkedComponent(module.id, targetId);
      if (!target) {
        return res
          .status(400)
          .json({ error: 'target_component_id must be a component of this module' });
      }
      const label = String(rawLabel || '').trim();
      let source = null;
      if (sourceId) {
        source = await linkedComponent(module.id, sourceId);
        if (!source) {
          return res
            .status(400)
            .json({ error: 'source_component_id must be a component of this module' });
        }
        if (source.id === target.id) {
          return res.status(400).json({ error: 'a component cannot be normalled to itself' });
        }
      } else if (!label) {
        return res
          .status(400)
          .json({ error: 'either source_component_id or source_label is required' });
      }

      // What cancels this default. By default a cable into the target; an
      // output normalled to another output names the jack whose cable breaks
      // it instead, and whether it breaks on a cable in or out.
      let breakComponent = null;
      let breakOn = 'cable_in';
      if (breakId !== undefined && breakId !== null && breakId !== '') {
        breakComponent = await linkedComponent(module.id, breakId);
        if (!breakComponent) {
          return res
            .status(400)
            .json({ error: 'break_component_id must be a component of this module' });
        }
        if (!breakComponent.type.endsWith('_jack')) {
          return res.status(400).json({ error: 'break_component_id must be a jack' });
        }
        breakOn = String(rawBreakOn || 'cable_in').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!BREAK_MODES.includes(breakOn)) {
          return res
            .status(400)
            .json({ error: `break_on must be one of: ${BREAK_MODES.join(', ')}` });
        }
        if (breakComponent.id === target.id) breakComponent = null;
      }

      const condition = await readCondition(module, req.body);
      if (condition.error) return res.status(400).json({ error: condition.error });

      const existing = await ComponentNormalization.findAll({
        where: { module_id: module.id, target_component_id: target.id },
      });
      // The same source normalled to the same target in two different switch
      // positions is two distinct defaults, so the condition is part of a
      // normalization's identity.
      const sameCondition = (n) =>
        (n.condition_component_id ?? null) === condition.fields.condition_component_id &&
        (n.condition_value ?? '').toLowerCase() ===
          (condition.fields.condition_value ?? '').toLowerCase();
      const duplicate = existing.some(
        (n) =>
          sameCondition(n) &&
          (source
            ? n.source_component_id === source.id
            : (n.source_label || '').toLowerCase() === label.toLowerCase())
      );
      if (duplicate) {
        return res.status(409).json({ error: 'this normalled connection is already recorded' });
      }

      const description = String(rawDescription || '').trim();
      const row = await ComponentNormalization.create({
        module_id: module.id,
        target_component_id: target.id,
        source_component_id: source ? source.id : null,
        source_label: source ? null : label,
        kind: normalizationKind(source),
        ...condition.fields,
        break_component_id: breakComponent ? breakComponent.id : null,
        break_on: breakComponent ? breakOn : 'cable_in',
        description: description || null,
      });
      res.status(201).json({
        id: row.id,
        target_component_id: row.target_component_id,
        source_component_id: row.source_component_id,
        source_label: row.source_label,
        kind: row.kind,
        condition_component_id: row.condition_component_id,
        condition_value: row.condition_value,
        alt_group: row.alt_group,
        break_component_id: row.break_component_id,
        break_on: row.break_on,
        description: row.description,
      });
    } catch (e) {
      next(e);
    }
  });

  // Remove a normalled connection (analyzed or manually added).
  router.delete('/:id/normalizations/:normalizationId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const deleted = await ComponentNormalization.destroy({
        where: { id: Number(req.params.normalizationId), module_id: module.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Normalization not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Record an internal signal path the analysis missed: the input jack's
  // signal (possibly processed) appears at the output jack. Shared hardware
  // fact — any user with the module racked may correct them; re-analysis
  // rewrites them. Body: { input_component_id, output_component_id, description? }
  router.post('/:id/routes', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      // Either end may sit on an expander panel wired to this module.
      const input = await linkedComponent(module.id, req.body?.input_component_id);
      const output = await linkedComponent(module.id, req.body?.output_component_id);
      if (!input || input.type !== 'input_jack') {
        return res
          .status(400)
          .json({ error: 'input_component_id must be an input jack of this module' });
      }
      if (!output || output.type !== 'output_jack') {
        return res
          .status(400)
          .json({ error: 'output_component_id must be an output jack of this module' });
      }
      const condition = await readCondition(module, req.body);
      if (condition.error) return res.status(400).json({ error: condition.error });
      const existing = await ComponentRoute.findAll({
        where: { module_id: module.id, input_component_id: input.id },
      });
      // One pair of jacks may hold several paths, one per control position
      // (Levit8's OUT 4 is a pass-through or a 4-channel mix depending on its
      // MIX switch), so a path is only a duplicate under the same condition.
      const duplicate = existing.some(
        (r) =>
          r.output_component_id === output.id &&
          (r.condition_component_id ?? null) === condition.fields.condition_component_id &&
          (r.condition_value ?? '').toLowerCase() ===
            (condition.fields.condition_value ?? '').toLowerCase()
      );
      if (duplicate) {
        return res.status(409).json({ error: 'this signal path is already recorded' });
      }
      const description = String(req.body?.description || '').trim();
      const row = await ComponentRoute.create({
        module_id: module.id,
        input_component_id: input.id,
        output_component_id: output.id,
        ...condition.fields,
        description: description || null,
      });
      res.status(201).json({
        id: row.id,
        input_component_id: row.input_component_id,
        output_component_id: row.output_component_id,
        condition_component_id: row.condition_component_id,
        condition_value: row.condition_value,
        alt_group: row.alt_group,
        description: row.description,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/routes/:routeId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const deleted = await ComponentRoute.destroy({
        where: { id: Number(req.params.routeId) || 0, module_id: module.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Route not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Record a routing switch section the analysis missed: the common jack
  // connects to exactly one step jack at a time. Shared hardware fact; a
  // re-analysis rewrites them. Body:
  // { common_component_id, step_component_ids: [...], name?, description? }
  router.post('/:id/switches', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const common = await ModuleComponent.findOne({
        where: { id: Number(req.body?.common_component_id) || 0, module_id: module.id },
      });
      if (!common || !common.type.endsWith('_jack')) {
        return res
          .status(400)
          .json({ error: 'common_component_id must be a jack of this module' });
      }
      const rawSteps = Array.isArray(req.body?.step_component_ids)
        ? req.body.step_component_ids
        : [];
      const stepIds = [...new Set(rawSteps.map((s) => Number(s) || 0))].filter(
        (id) => id > 0 && id !== common.id
      );
      if (stepIds.length < 2) {
        return res
          .status(400)
          .json({ error: 'step_component_ids must name at least two other jacks' });
      }
      const steps = await ModuleComponent.findAll({
        where: { id: stepIds, module_id: module.id },
      });
      if (steps.length !== stepIds.length || steps.some((s) => !s.type.endsWith('_jack'))) {
        return res
          .status(400)
          .json({ error: 'every step must be a jack of this module' });
      }
      if (await ComponentSwitch.findOne({
        where: { module_id: module.id, common_component_id: common.id },
      })) {
        return res
          .status(409)
          .json({ error: `a switch section with common '${common.name}' is already recorded` });
      }
      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || '').trim();
      // Section + steps land together.
      let row;
      await db.sequelize.transaction(async (transaction) => {
        row = await ComponentSwitch.create(
          {
            module_id: module.id,
            name: name || null,
            common_component_id: common.id,
            description: description || null,
          },
          { transaction }
        );
        await ComponentSwitchStep.bulkCreate(
          stepIds.map((componentId, i) => ({
            switch_id: row.id,
            component_id: componentId,
            position: i + 1,
          })),
          { transaction }
        );
      });
      res.status(201).json({
        id: row.id,
        name: row.name,
        common_component_id: row.common_component_id,
        step_component_ids: stepIds,
        description: row.description,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/switches/:switchId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const row = await ComponentSwitch.findOne({
        where: { id: Number(req.params.switchId) || 0, module_id: module.id },
      });
      if (!row) return res.status(404).json({ error: 'Switch not found' });
      await db.sequelize.transaction(async (transaction) => {
        await ComponentSwitchStep.destroy({ where: { switch_id: row.id }, transaction });
        await row.destroy({ transaction });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- stereo (and other) jack pairs ----
  // Two jacks that carry the two halves of one signal. Recording the pair
  // lets a patch plug both ends in one step and show them as one connection.
  // Body: { a_component_id, b_component_id, kind?, description? }
  router.post('/:id/pairs', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const a = await ModuleComponent.findOne({
        where: { id: Number(req.body?.a_component_id) || 0, module_id: module.id },
      });
      const b = await ModuleComponent.findOne({
        where: { id: Number(req.body?.b_component_id) || 0, module_id: module.id },
      });
      if (!a || !b || !a.type.endsWith('_jack') || !b.type.endsWith('_jack')) {
        return res
          .status(400)
          .json({ error: 'a_component_id and b_component_id must both be jacks of this module' });
      }
      if (a.id === b.id) {
        return res.status(400).json({ error: 'a jack cannot be paired with itself' });
      }
      // A jack carries one half of one signal, so it belongs to one pair.
      const existing = await ComponentPair.findAll({ where: { module_id: module.id } });
      const taken = existing.find((p) =>
        [p.a_component_id, p.b_component_id].some((id) => id === a.id || id === b.id)
      );
      if (taken) {
        return res.status(409).json({ error: 'one of those jacks is already part of a pair' });
      }
      const row = await ComponentPair.create({
        module_id: module.id,
        a_component_id: a.id,
        b_component_id: b.id,
        kind: String(req.body?.kind || '').trim().toLowerCase() || 'stereo',
        description: String(req.body?.description || '').trim() || null,
      });
      res.status(201).json({
        id: row.id,
        a_component_id: row.a_component_id,
        b_component_id: row.b_component_id,
        kind: row.kind,
        description: row.description,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/pairs/:pairId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const deleted = await ComponentPair.destroy({
        where: { id: Number(req.params.pairId) || 0, module_id: module.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Pair not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- expanders ----
  // Declare that another module is an expander of this one: two panels joined
  // by a ribbon cable that work as one instrument (Atlantix + Atlx, Quad
  // Operator + Algo, Bohm + Groove). Once declared, this module's routes and
  // normalizations may reach the expander's jacks, and a patch holding both
  // instances traces signal across the pair. Body: { expander_module_id }
  router.post('/:id/expanders', async (req, res, next) => {
    try {
      const host = await userModule(req.user.id, req.params.id);
      if (!host) return res.status(404).json({ error: 'Module not found' });
      const expander = await userModule(req.user.id, req.body?.expander_module_id);
      if (!expander) {
        return res
          .status(400)
          .json({ error: 'expander_module_id must be a module in one of your racks' });
      }
      if (expander.id === host.id) {
        return res.status(400).json({ error: 'a module cannot expand itself' });
      }
      const existing = await ModuleExpander.findOne({
        where: {
          [Op.or]: [
            { host_module_id: host.id, expander_module_id: expander.id },
            { host_module_id: expander.id, expander_module_id: host.id },
          ],
        },
      });
      if (existing) {
        return res.status(409).json({ error: 'these two modules are already linked' });
      }
      const row = await ModuleExpander.create({
        host_module_id: host.id,
        expander_module_id: expander.id,
        description: String(req.body?.description || '').trim() || null,
      });
      // Paths the manual described across the two panels can be created now
      // that the link exists.
      await refreshModuleLinks(db, host);
      res.status(201).json({
        id: row.id,
        role: 'expander',
        module_id: expander.id,
        manufacturer: expander.manufacturer,
        name: expander.name,
        description: row.description,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/expanders/:expanderId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      // Either side of the pair may unlink it.
      const deleted = await ModuleExpander.destroy({
        where: {
          id: Number(req.params.expanderId) || 0,
          [Op.or]: [{ host_module_id: module.id }, { expander_module_id: module.id }],
        },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Expander link not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Reclassify a component the analysis got wrong — most commonly turning a
  // mult's jacks into 'bidirectional_jack' (any of them can take the input;
  // the rest copy it out) and grouping them into sections via group_label.
  // Shared hardware fact: any user with the module racked may correct it.
  // Body: { type?, group_label? } (at least one).
  router.put('/:id/components/:componentId', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const component = await ModuleComponent.findOne({
        where: { id: Number(req.params.componentId) || 0, module_id: module.id },
      });
      if (!component) return res.status(404).json({ error: 'Component not found' });
      const updates = {};
      if (req.body?.type !== undefined) {
        const type = String(req.body.type || '').trim().toLowerCase();
        if (!COMPONENT_TYPES.includes(type)) {
          return res
            .status(400)
            .json({ error: `type must be one of: ${COMPONENT_TYPES.join(', ')}` });
        }
        updates.type = type;
      }
      if (req.body?.group_label !== undefined) {
        updates.group_label = String(req.body.group_label || '').trim() || null;
      }
      // The physical connector, for connection points that are not ordinary
      // 3.5mm patch points: a MIDI socket, a USB port, a built-in mic.
      if (req.body?.port_kind !== undefined) {
        const portKind = String(req.body.port_kind || '')
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
        if (portKind && !PORT_KINDS.includes(portKind)) {
          return res.status(400).json({ error: `port_kind must be one of: ${PORT_KINDS.join(', ')}` });
        }
        updates.port_kind = portKind || null;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'type, group_label or port_kind is required' });
      }
      await component.update(updates);
      res.json({
        id: component.id,
        type: component.type,
        name: component.name,
        description: component.description,
        voltage_min: component.voltage_min,
        voltage_max: component.voltage_max,
        polarity: component.polarity,
        group_label: component.group_label,
        port_kind: component.port_kind,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---- component values ----
  // The valid values of a component ('min'/'max' range ends or 'enum'
  // positions) are extracted from the manual during analysis, but like
  // components and normalizations they are shared hardware facts any user
  // with the module racked may correct. A re-analysis rewrites them.

  async function ownComponent(userId, moduleId, componentId) {
    const module = await userModule(userId, moduleId);
    if (!module) return { error: 'Module not found' };
    const component = await ModuleComponent.findOne({
      where: { id: Number(componentId) || 0, module_id: module.id },
    });
    if (!component) return { error: 'Component not found' };
    return { module, component };
  }

  // A duplicate value row: a second 'min'/'max' for the component, or an
  // 'enum' repeating an existing label (case-insensitively).
  function valueConflict(rows, type, value, excludeId = null) {
    return rows.some((row) => {
      if (excludeId !== null && row.id === excludeId) return false;
      if (type === 'enum') {
        return row.type === 'enum' && row.value.toLowerCase() === value.toLowerCase();
      }
      return row.type === type;
    });
  }

  const valueJson = (row) => ({
    id: row.id,
    component_id: row.component_id,
    type: row.type,
    value: row.value,
    description: row.description,
  });

  // Body: { type: 'min'|'max'|'enum', value, description? }
  router.post('/:id/components/:componentId/values', async (req, res, next) => {
    try {
      const { error, component } = await ownComponent(
        req.user.id,
        req.params.id,
        req.params.componentId
      );
      if (error) return res.status(404).json({ error });
      const type = String(req.body?.type || '').trim().toLowerCase();
      if (!VALUE_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${VALUE_TYPES.join(', ')}` });
      }
      const value = String(req.body?.value ?? '').trim();
      if (!value) return res.status(400).json({ error: 'value is required' });
      const existing = await ComponentValue.findAll({ where: { component_id: component.id } });
      if (valueConflict(existing, type, value)) {
        return res.status(409).json({
          error:
            type === 'enum'
              ? `this component already has the value '${value}'`
              : `this component already has a ${type} — edit or delete it instead`,
        });
      }
      const description = String(req.body?.description || '').trim();
      const row = await ComponentValue.create({
        component_id: component.id,
        type,
        value,
        description: description || null,
      });
      res.status(201).json(valueJson(row));
    } catch (e) {
      next(e);
    }
  });

  // Update a value's label/description (the type stays fixed).
  // Body: { value, description? }
  router.put('/:id/components/:componentId/values/:valueId', async (req, res, next) => {
    try {
      const { error, component } = await ownComponent(
        req.user.id,
        req.params.id,
        req.params.componentId
      );
      if (error) return res.status(404).json({ error });
      const row = await ComponentValue.findOne({
        where: { id: Number(req.params.valueId) || 0, component_id: component.id },
      });
      if (!row) return res.status(404).json({ error: 'Value not found' });
      const value = String(req.body?.value ?? '').trim();
      if (!value) return res.status(400).json({ error: 'value is required' });
      const existing = await ComponentValue.findAll({ where: { component_id: component.id } });
      if (valueConflict(existing, row.type, value, row.id)) {
        return res.status(409).json({ error: `this component already has the value '${value}'` });
      }
      const description = String(req.body?.description || '').trim();
      await row.update({ value, description: description || null });
      res.json(valueJson(row));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/components/:componentId/values/:valueId', async (req, res, next) => {
    try {
      const { error, component } = await ownComponent(
        req.user.id,
        req.params.id,
        req.params.componentId
      );
      if (error) return res.status(404).json({ error });
      const deleted = await ComponentValue.destroy({
        where: { id: Number(req.params.valueId) || 0, component_id: component.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Value not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Attach an additional PDF document to your module instance. Body:
  // { name, filename, data_base64 }. Private to the uploading user. The name
  // labels the document; 'manual' is reserved for the shared auto-found
  // manual, so uploads must pick something else.
  router.post('/:id/manuals', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });

      const { name: rawName, filename, data_base64: dataBase64 } = req.body || {};
      if (!rawName || !filename || !dataBase64) {
        return res.status(400).json({ error: 'name, filename and data_base64 are required' });
      }
      const name = String(rawName).trim();
      if (!name) return res.status(400).json({ error: 'name, filename and data_base64 are required' });
      if (name.toLowerCase() === 'manual') {
        return res.status(400).json({ error: "'manual' is reserved for the shared manual" });
      }
      let data;
      try {
        data = Buffer.from(String(dataBase64), 'base64');
      } catch {
        return res.status(400).json({ error: 'data_base64 is not valid base64' });
      }
      if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'file is empty or larger than 25MB' });
      }

      const { ok, reason } = isProbablyPdfBuffer(data);
      if (!ok) return res.status(400).json({ error: `not a valid PDF (${reason})` });

      // Content-addressed storage: the file lands at <sha256>.pdf, so a
      // document that already exists (under any record) is stored once.
      const hash = sha256Buffer(data);
      const dest = manualPath(manualsDir, hash);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(manualsDir, { recursive: true });
        fs.writeFileSync(dest, data);
      }

      // Re-uploading a document you already attached references the existing
      // record instead of creating a duplicate (the original name is kept).
      const existing = await Manual.findOne({
        where: { module_id: module.id, user_id: req.user.id, hash },
      });
      // A database name may not be reused for different content (backed by
      // the unique index on (module_id, name, hash)).
      if (!existing) {
        const nameTaken = await Manual.findOne({
          where: { module_id: module.id, user_id: req.user.id, name },
        });
        if (nameTaken) {
          return res
            .status(409)
            .json({ error: `you already have a document named '${name}' on this module` });
        }
      }
      const manual =
        existing ||
        (await Manual.create({
          module_id: module.id,
          user_id: req.user.id,
          hash,
          name,
          original_name: String(filename),
          source: 'upload',
        }));
      const { id, original_name, source, user_id, created_at } = manual;
      res
        .status(existing ? 200 : 201)
        .json({ id, hash, name: manual.name, original_name, source, user_id, created_at });
    } catch (e) {
      next(e);
    }
  });

  // Remove one of your own uploaded documents (the shared manual cannot be
  // deleted this way).
  router.delete('/:id/manuals/:manualId', async (req, res, next) => {
    try {
      const manual = await Manual.findOne({
        where: {
          id: Number(req.params.manualId),
          module_id: Number(req.params.id),
          user_id: req.user.id,
        },
      });
      if (!manual) return res.status(404).json({ error: 'Document not found' });
      await manual.destroy();
      // The file is shared by every record with the same content hash; only
      // remove it once the last reference is gone.
      const remaining = await Manual.count({ where: { hash: manual.hash } });
      if (remaining === 0) fs.rmSync(manualPath(manualsDir, manual.hash), { force: true });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
