import { Router } from 'express';
import { normalizationKind } from '../../services/manualNormalize.js';
import { BREAK_MODES } from '../../services/manualVocabulary.js';
import { linkedComponent, readCondition, requireOwnedModule } from './helpers.js';
import {
  multGroupJson,
  normalizationJson,
  pairJson,
  routeJson,
  switchJson,
} from '../../services/moduleJson.js';
import { asyncHandler } from '../asyncHandler.js';

// Signal-path facts: normalled connections, internal routes, routing switch
// sections and stereo jack pairs. All shared hardware facts a re-analysis
// rewrites.
export function moduleSignalRoutes(db) {
  const {
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentMultGroup,
    ComponentPair,
  } = db.models;
  const router = Router();

  // Manually record a normalled connection the analysis missed. Body:
  // { target_component_id, source_component_id | source_label, description }.
  // Like components, normalizations are shared hardware facts: any user who
  // has the module racked may correct them, and a re-analysis replaces manual
  // rows along with the analyzed ones. kind is derived from the source.
  router.post('/:id/normalizations', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const {
      target_component_id: targetId,
      source_component_id: sourceId,
      source_label: rawLabel,
      break_component_id: breakId,
      break_on: rawBreakOn,
      description: rawDescription,
    } = req.body || {};

    const target = await linkedComponent(db, module.id, targetId);
    if (!target) {
      return res
        .status(400)
        .json({ error: 'target_component_id must be a component of this module' });
    }
    const label = String(rawLabel || '').trim();
    let source = null;
    if (sourceId) {
      source = await linkedComponent(db, module.id, sourceId);
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
      breakComponent = await linkedComponent(db, module.id, breakId);
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

    const condition = await readCondition(db, module, req.body);
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
    res.status(201).json(normalizationJson(row));
  }));

  // Remove a normalled connection (analyzed or manually added).
  router.delete('/:id/normalizations/:normalizationId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const deleted = await ComponentNormalization.destroy({
      where: { id: Number(req.params.normalizationId), module_id: module.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Normalization not found' });
    res.json({ ok: true });
  }));

  // Record an internal signal path the analysis missed: the input jack's
  // signal (possibly processed) appears at the output jack. Shared hardware
  // fact — any user with the module racked may correct them; re-analysis
  // rewrites them. Body: { input_component_id, output_component_id, description? }
  router.post('/:id/routes', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    // Either end may sit on an expander panel wired to this module.
    const input = await linkedComponent(db, module.id, req.body?.input_component_id);
    const output = await linkedComponent(db, module.id, req.body?.output_component_id);
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
    const condition = await readCondition(db, module, req.body);
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
    res.status(201).json(routeJson(row));
  }));

  router.delete('/:id/routes/:routeId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const deleted = await ComponentRoute.destroy({
      where: { id: Number(req.params.routeId) || 0, module_id: module.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Route not found' });
    res.json({ ok: true });
  }));

  // Record a routing switch section the analysis missed: the common jack
  // connects to exactly one step jack at a time. Shared hardware fact; a
  // re-analysis rewrites them. Body:
  // { common_component_id, step_component_ids: [...], name?, description? }
  router.post('/:id/switches', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
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
    res.status(201).json(switchJson(row, stepIds));
  }));

  router.delete('/:id/switches/:switchId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const row = await ComponentSwitch.findOne({
      where: { id: Number(req.params.switchId) || 0, module_id: module.id },
    });
    if (!row) return res.status(404).json({ error: 'Switch not found' });
    await db.sequelize.transaction(async (transaction) => {
      await ComponentSwitchStep.destroy({ where: { switch_id: row.id }, transaction });
      await row.destroy({ transaction });
    });
    res.json({ ok: true });
  }));

  // ---- switched mult groups ----
  // Which mult section a bidirectional jack joins while a control sits at one
  // position (Doepfer A-182-1: a three-position toggle per jack, putting it
  // on bus 1, bus 2 or neither). A jack with no rows here keeps its
  // unconditional group_label, so an ordinary mult needs none of this.
  // Body: { component_id, condition_component_id, condition_value,
  //         group_label?, description? } — no group_label means the jack is
  // on no bus in that position, which is a real position to record.
  router.post('/:id/mult-groups', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const jack = await ModuleComponent.findOne({
      where: { id: Number(req.body?.component_id) || 0, module_id: module.id },
    });
    if (!jack || jack.type !== 'bidirectional_jack') {
      return res
        .status(400)
        .json({ error: 'component_id must be a bidirectional jack of this module' });
    }
    const condition = await readCondition(db, module, req.body);
    if (condition.error) return res.status(400).json({ error: condition.error });
    if (!condition.fields.condition_component_id) {
      return res.status(400).json({
        error:
          'a switched group names the control that decides it — a jack whose section never changes takes a group_label instead',
      });
    }
    const label = String(req.body?.group_label || '').trim() || null;
    // One position of one control decides one thing, so the same jack cannot
    // be told twice what to do in it.
    const clash = await ComponentMultGroup.findAll({
      where: { module_id: module.id, component_id: jack.id },
    });
    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    if (
      clash.some(
        (row) =>
          row.condition_component_id === condition.fields.condition_component_id &&
          same(row.condition_value, condition.fields.condition_value)
      )
    ) {
      return res.status(409).json({
        error: `'${jack.name}' already has a group recorded for that position`,
      });
    }
    const row = await ComponentMultGroup.create({
      module_id: module.id,
      component_id: jack.id,
      group_label: label,
      condition_component_id: condition.fields.condition_component_id,
      condition_value: condition.fields.condition_value,
      description: String(req.body?.description || '').trim() || null,
    });
    res.status(201).json(multGroupJson(row));
  }));

  router.delete('/:id/mult-groups/:groupId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const row = await ComponentMultGroup.findOne({
      where: { id: Number(req.params.groupId) || 0, module_id: module.id },
    });
    if (!row) return res.status(404).json({ error: 'Switched group not found' });
    await row.destroy();
    res.json({ ok: true });
  }));

  // ---- stereo (and other) jack pairs ----
  // Two jacks that carry the two halves of one signal. Recording the pair
  // lets a patch plug both ends in one step and show them as one connection.
  // Body: { a_component_id, b_component_id, kind?, description? }
  router.post('/:id/pairs', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
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
    res.status(201).json(pairJson(row));
  }));

  router.delete('/:id/pairs/:pairId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const deleted = await ComponentPair.destroy({
      where: { id: Number(req.params.pairId) || 0, module_id: module.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Pair not found' });
    res.json({ ok: true });
  }));

  return router;
}
