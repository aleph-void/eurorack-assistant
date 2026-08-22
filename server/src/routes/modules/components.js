import { Router } from 'express';
import { VALUE_TYPES } from '../../services/manualNormalize.js';
import { COMPONENT_TYPES, PORT_KINDS } from '../../services/manualVocabulary.js';
import { fillMissingPlacements } from '../../services/panelPlacements.js';
import { requireOwnedModule } from './helpers.js';
import { componentJson, valueJson } from '../../services/moduleJson.js';
import { asyncHandler } from '../asyncHandler.js';

// The component inventory and each component's valid values — corrections to
// what the manual analysis produced.
export function moduleComponentRoutes(db) {
  const {
    ModuleComponent,
    ComponentValue,
    ModulePanel,
    ModulePanelComponent,
  } = db.models;
  const router = Router();

  // Correct a component the analysis got wrong — a misread name or
  // description, or a wrong type (most commonly turning a mult's jacks into
  // 'bidirectional_jack': any of them can take the input; the rest copy it
  // out) and grouping them into sections via group_label.
  // Shared hardware fact: any user with the module racked may correct it.
  // Body: { name?, description?, type?, group_label? } (at least one).
  router.put('/:id/components/:componentId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const component = await ModuleComponent.findOne({
      where: { id: Number(req.params.componentId) || 0, module_id: module.id },
    });
    if (!component) return res.status(404).json({ error: 'Component not found' });
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = String(req.body.description || '').trim() || null;
    }
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
      return res
        .status(400)
        .json({ error: 'name, description, type, group_label or port_kind is required' });
    }
    await component.update(updates);
    // Panel markers snapshot the component name for their labels — keep them
    // reading the corrected name.
    if (updates.name) {
      await ModulePanelComponent.update(
        { name: updates.name },
        { where: { component_id: component.id } }
      );
    }
    res.json(componentJson(component));
  }));

  // ---- component values ----
  // The valid values of a component ('min'/'max' range ends or 'enum'
  // positions) are extracted from the manual during analysis, but like
  // components and normalizations they are shared hardware facts any user
  // with the module racked may correct. A re-analysis rewrites them.

  // The component under req.params.componentId on the (ownership-checked)
  // module, or null.
  function moduleComponent(module, componentId) {
    return ModuleComponent.findOne({
      where: { id: Number(componentId) || 0, module_id: module.id },
    });
  }

  // A manual analysis is a useful starting inventory, not a locked one.
  // Users can add a missing control or remove a spurious one without waiting
  // for another analysis (which would overwrite their correction anyway).
  // Body: { name, type, description? }
  router.post('/:id/components', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const type = String(req.body?.type || '').trim().toLowerCase();
    if (!COMPONENT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${COMPONENT_TYPES.join(', ')}` });
    }
    const component = await ModuleComponent.create({
      module_id: module.id,
      name,
      type,
      description: String(req.body?.description || '').trim() || null,
    });
    // A hand-added component should be usable on an existing panel straight
    // away. Put a temporary marker in the same free-space layout used for
    // components the panel analysis missed; it can then be dragged onto the
    // real hardware from the module page.
    const panel = await ModulePanel.findOne({ where: { module_id: module.id } });
    let placement = null;
    if (panel) {
      const [existing, components] = await Promise.all([
        ModulePanelComponent.findAll({ where: { panel_id: panel.id } }),
        ModuleComponent.findAll({ where: { module_id: module.id } }),
      ]);
      const planned = fillMissingPlacements(
        existing.map((row) => row.get({ plain: true })),
        components.map((row) => row.get({ plain: true }))
      ).find((row) => row.component_id === component.id);
      if (planned) {
        placement = await ModulePanelComponent.create({
          panel_id: panel.id,
          component_id: component.id,
          name: component.name,
          shape: planned.shape,
          x: planned.x,
          y: planned.y,
          w: planned.w,
          h: planned.h,
        });
      }
    }
    res.status(201).json(componentJson(component, { panel_placement_id: placement?.id ?? null }));
  }));

  router.delete('/:id/components/:componentId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const component = await moduleComponent(req.module, req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });
    await component.destroy();
    res.json({ ok: true });
  }));

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

  // Body: { type: 'min'|'max'|'enum', value, description? }
  router.post('/:id/components/:componentId/values', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const component = await moduleComponent(req.module, req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });
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
  }));

  // Update a value's label/description (the type stays fixed).
  // Body: { value, description? }
  router.put('/:id/components/:componentId/values/:valueId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const component = await moduleComponent(req.module, req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });
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
  }));

  router.delete('/:id/components/:componentId/values/:valueId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const component = await moduleComponent(req.module, req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });
    const deleted = await ComponentValue.destroy({
      where: { id: Number(req.params.valueId) || 0, component_id: component.id },
    });
    if (deleted === 0) return res.status(404).json({ error: 'Value not found' });
    res.json({ ok: true });
  }));

  return router;
}
