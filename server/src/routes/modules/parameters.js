import { Router } from 'express';
import { requireOwnedModule } from './helpers.js';
import { requireBudget } from '../../services/budgets.js';
import { enqueueModuleJob } from '../../jobs/enqueue.js';
import { parameterJson, parameterOptionJson } from '../../services/moduleJson.js';
import {
  PARAMETER_VALUE_TYPES,
  parametersByModule,
} from '../../services/moduleParameters.js';
import { asyncHandler } from '../asyncHandler.js';

// The module's MENU parameters — the settings it keeps behind an encoder and
// a screen rather than under a control of its own — and the options each one
// offers. Shared hardware facts like components and normalizations: any user
// with the module racked may correct them, and the correction shows for
// everyone sharing the record.
export function moduleParameterRoutes(db) {
  const { ModuleComponent, ModuleParameter, ModuleParameterOption } = db.models;
  const router = Router();

  const parameterOf = (module, parameterId) =>
    ModuleParameter.findOne({
      where: { id: Number(parameterId) || 0, module_id: module.id },
    });

  // The component a parameter configures, resolved off the same module.
  // Returns { ok: true, id } — id null for a parameter of the whole module —
  // or { error }.
  async function resolveComponent(module, raw) {
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, id: null, name: null };
    }
    const component = await ModuleComponent.findOne({
      where: { id: Number(raw) || 0, module_id: module.id },
    });
    if (!component) return { error: 'Component not found on this module' };
    // The name travels with the id: a re-analysis destroys every component
    // row, and the name is what the parameter is put back onto the new one by
    // (services/manualAnalyzer.js).
    return { ok: true, id: component.id, name: component.name };
  }

  function readValueType(raw) {
    const type = String(raw ?? '').trim().toLowerCase();
    if (!type) return { ok: true, type: 'enum' };
    if (!PARAMETER_VALUE_TYPES.includes(type)) {
      return { error: `value_type must be one of: ${PARAMETER_VALUE_TYPES.join(', ')}` };
    }
    return { ok: true, type };
  }

  const text = (raw, max = 200) => {
    const value = String(raw ?? '').trim();
    return value ? value.slice(0, max) : null;
  };

  router.get('/:id/parameters', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const byModule = await parametersByModule(db, [req.module.id]);
    res.json({ parameters: byModule.get(req.module.id) ?? [] });
  }));

  // Body: { name, component_id?, group_label?, value_type?, unit?, value_min?,
  //         value_max?, default_value?, description? }
  router.post('/:id/parameters', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const name = text(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const component = await resolveComponent(module, req.body?.component_id);
    if (component.error) return res.status(400).json({ error: component.error });
    const valueType = readValueType(req.body?.value_type);
    if (valueType.error) return res.status(400).json({ error: valueType.error });
    // One name per component: a parameter list is a menu, and two "Division"
    // entries on OUT 1 is a mis-typed second copy, not a second setting.
    const existing = await ModuleParameter.findAll({ where: { module_id: module.id } });
    const clash = existing.some(
      (p) =>
        (p.component_id ?? null) === component.id &&
        String(p.name).toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      return res.status(409).json({ error: `this module already has a '${name}' parameter here` });
    }
    const row = await ModuleParameter.create({
      module_id: module.id,
      component_id: component.id,
      component_name: component.name,
      name,
      group_label: text(req.body?.group_label),
      value_type: valueType.type,
      unit: text(req.body?.unit, 40),
      value_min: text(req.body?.value_min, 80),
      value_max: text(req.body?.value_max, 80),
      default_value: text(req.body?.default_value),
      description: text(req.body?.description, 2000),
      position: existing.reduce((max, p) => Math.max(max, p.position ?? 0), 0) + 1,
    });
    res.status(201).json(parameterJson(row, { options: [] }));
  }));

  router.put('/:id/parameters/:parameterId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const row = await parameterOf(module, req.params.parameterId);
    if (!row) return res.status(404).json({ error: 'Parameter not found' });
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name);
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name;
    }
    if (req.body?.component_id !== undefined) {
      const component = await resolveComponent(module, req.body.component_id);
      if (component.error) return res.status(400).json({ error: component.error });
      updates.component_id = component.id;
      updates.component_name = component.name;
    }
    if (req.body?.value_type !== undefined) {
      const valueType = readValueType(req.body.value_type);
      if (valueType.error) return res.status(400).json({ error: valueType.error });
      updates.value_type = valueType.type;
    }
    for (const [field, max] of [
      ['group_label', 200],
      ['unit', 40],
      ['value_min', 80],
      ['value_max', 80],
      ['default_value', 200],
      ['description', 2000],
    ]) {
      if (req.body?.[field] !== undefined) updates[field] = text(req.body[field], max);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    await row.update(updates);
    const options = await ModuleParameterOption.findAll({
      where: { parameter_id: row.id },
      order: [
        ['position', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    res.json(parameterJson(row, { options: options.map(parameterOptionJson) }));
  }));

  router.delete('/:id/parameters/:parameterId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const row = await parameterOf(req.module, req.params.parameterId);
    if (!row) return res.status(404).json({ error: 'Parameter not found' });
    await row.destroy();
    res.json({ ok: true });
  }));

  // ---- the options a parameter offers ----

  // Body: { value, description? }
  router.post('/:id/parameters/:parameterId/options', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const parameter = await parameterOf(req.module, req.params.parameterId);
    if (!parameter) return res.status(404).json({ error: 'Parameter not found' });
    const value = text(req.body?.value);
    if (!value) return res.status(400).json({ error: 'value is required' });
    const existing = await ModuleParameterOption.findAll({
      where: { parameter_id: parameter.id },
    });
    if (existing.some((o) => o.value.toLowerCase() === value.toLowerCase())) {
      return res.status(409).json({ error: `this parameter already offers '${value}'` });
    }
    const row = await ModuleParameterOption.create({
      parameter_id: parameter.id,
      value,
      description: text(req.body?.description, 500),
      position: existing.reduce((max, o) => Math.max(max, o.position ?? 0), 0) + 1,
    });
    res.status(201).json(parameterOptionJson(row));
  }));

  router.put('/:id/parameters/:parameterId/options/:optionId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const parameter = await parameterOf(req.module, req.params.parameterId);
    if (!parameter) return res.status(404).json({ error: 'Parameter not found' });
    const row = await ModuleParameterOption.findOne({
      where: { id: Number(req.params.optionId) || 0, parameter_id: parameter.id },
    });
    if (!row) return res.status(404).json({ error: 'Option not found' });
    const updates = {};
    if (req.body?.value !== undefined) {
      const value = text(req.body.value);
      if (!value) return res.status(400).json({ error: 'value cannot be empty' });
      updates.value = value;
    }
    if (req.body?.description !== undefined) {
      updates.description = text(req.body.description, 500);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'value or description is required' });
    }
    await row.update(updates);
    res.json(parameterOptionJson(row));
  }));

  router.delete('/:id/parameters/:parameterId/options/:optionId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const parameter = await parameterOf(req.module, req.params.parameterId);
    if (!parameter) return res.status(404).json({ error: 'Parameter not found' });
    const deleted = await ModuleParameterOption.destroy({
      where: { id: Number(req.params.optionId) || 0, parameter_id: parameter.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Option not found' });
    res.json({ ok: true });
  }));

  // Read the module's documents for its menu and record what it holds. A
  // narrow model pass that only ever ADDS — a parameter already recorded is
  // never rewritten, and the one blank it fills is an empty option list
  // (services/moduleParameters.js).
  router.post('/:id/parameters/find', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const { Manual } = db.models;
    // Anything the job could read: the shared manual and vendor pages, or the
    // caller's own uploads, which the scoped set picks up just the same.
    const documents = await Manual.findAll({
      where: { module_id: module.id },
      attributes: ['id', 'user_id'],
    });
    if (!documents.some((m) => m.user_id === null || m.user_id === req.user.id)) {
      return res.status(409).json({ error: 'This module has no documents to read a menu from' });
    }
    const job = await enqueueModuleJob(db, 'find_parameters', module, req.user.id);
    if (!job) {
      return res.status(409).json({ error: 'A menu parameter search is already queued for this module' });
    }
    res.status(202).json({ job_id: job.id });
  }));

  return router;
}
