import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { resolveNormalledSignals } from '../services/patchSignals.js';
import { buildSignalFlow } from '../services/patchFlow.js';

// A user's patches. A patch is created FROM a rack but owns a snapshot of the
// rack's contents (patch_modules, one row per module instance): modules can
// move to other racks, be re-analyzed (rewriting their components under new
// ids) or be deleted afterwards, and the patch keeps showing the rack as it
// was. Live module/component rows are joined in at read time for as long as
// they exist — the denormalized name columns take over when they don't.
// Patches are strictly private to their owner.
export function patchRoutes(db) {
  const {
    Rack,
    RackModule,
    Module,
    ModuleComponent,
    ComponentValue,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    Patch,
    PatchModule,
    PatchCable,
    PatchSetting,
  } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  function ownPatch(userId, id) {
    return Patch.findOne({ where: { id: Number(id) || 0, user_id: userId } });
  }

  const patchJson = (patch, extra = {}) => ({
    id: patch.id,
    name: patch.name,
    description: patch.description,
    rack_id: patch.rack_id,
    rack_name: patch.rack_name,
    created_at: patch.created_at,
    updated_at: patch.updated_at,
    ...extra,
  });

  router.get('/', async (req, res, next) => {
    try {
      const patches = await Patch.findAll({
        where: { user_id: req.user.id },
        order: [['id', 'DESC']],
      });
      const ids = patches.map((p) => p.id);
      // Counts grouped in JS (pg-mem-friendly flat queries).
      const [moduleRows, cableRows] = ids.length
        ? await Promise.all([
            PatchModule.findAll({ where: { patch_id: ids }, attributes: ['patch_id'] }),
            PatchCable.findAll({ where: { patch_id: ids }, attributes: ['patch_id'] }),
          ])
        : [[], []];
      const count = (rows) => {
        const map = new Map();
        for (const r of rows) map.set(r.patch_id, (map.get(r.patch_id) ?? 0) + 1);
        return map;
      };
      const moduleCounts = count(moduleRows);
      const cableCounts = count(cableRows);
      res.json(
        patches.map((p) =>
          patchJson(p, {
            module_count: moduleCounts.get(p.id) ?? 0,
            cable_count: cableCounts.get(p.id) ?? 0,
          })
        )
      );
    } catch (e) {
      next(e);
    }
  });

  // Create a patch from one of the user's racks, snapshotting the rack's
  // current contents. Body: { rack_id, name, description? }
  router.post('/', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const rack = await Rack.findOne({
        where: { id: Number(req.body?.rack_id) || 0, user_id: req.user.id },
      });
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      const mappings = await RackModule.findAll({
        where: { rack_id: rack.id },
        include: [Module],
        order: [
          [Module, 'manufacturer', 'ASC'],
          [Module, 'name', 'ASC'],
        ],
      });
      if (mappings.length === 0) {
        return res.status(400).json({ error: 'this rack has no modules to patch' });
      }
      const description = String(req.body?.description || '').trim();
      // One patch_modules row per module INSTANCE: quantity 2 becomes
      // instance 1 and instance 2 so cables can tell them apart.
      const snapshot = mappings.flatMap((rm) =>
        Array.from({ length: Math.max(1, rm.quantity) }, (_, i) => ({
          module_id: rm.Module.id,
          manufacturer: rm.Module.manufacturer,
          module_name: rm.Module.name,
          instance: i + 1,
        }))
      );
      let patch;
      await db.sequelize.transaction(async (transaction) => {
        patch = await Patch.create(
          {
            user_id: req.user.id,
            rack_id: rack.id,
            rack_name: rack.name,
            name,
            description: description || null,
          },
          { transaction }
        );
        await PatchModule.bulkCreate(
          snapshot.map((m) => ({ ...m, patch_id: patch.id })),
          { transaction }
        );
      });
      res.status(201).json(patchJson(patch, { module_count: snapshot.length, cable_count: 0 }));
    } catch (e) {
      next(e);
    }
  });

  // Full detail: the snapshot modules (with each live module's components and
  // their valid values joined in), the cables, and the settings.
  router.get('/:id', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const patchModules = await PatchModule.findAll({
        where: { patch_id: patch.id },
        order: [['id', 'ASC']],
      });
      const moduleIds = [...new Set(patchModules.map((pm) => pm.module_id).filter(Boolean))];
      const liveModules =
        moduleIds.length === 0 ? [] : await Module.findAll({ where: { id: moduleIds } });
      const liveIds = new Set(liveModules.map((m) => m.id));
      const components =
        liveIds.size === 0
          ? []
          : await ModuleComponent.findAll({
              where: { module_id: [...liveIds] },
              order: [
                ['type', 'ASC'],
                ['id', 'ASC'],
              ],
            });
      const valueRows =
        components.length === 0
          ? []
          : await ComponentValue.findAll({
              where: { component_id: components.map((c) => c.id) },
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
      const componentsByModule = new Map();
      for (const c of components) {
        if (!componentsByModule.has(c.module_id)) componentsByModule.set(c.module_id, []);
        componentsByModule.get(c.module_id).push({
          id: c.id,
          type: c.type,
          name: c.name,
          description: c.description,
          voltage_min: c.voltage_min,
          voltage_max: c.voltage_max,
          polarity: c.polarity,
          group_label: c.group_label,
          values: valuesByComponent.get(c.id) ?? [],
        });
      }
      const cables = await PatchCable.findAll({
        where: { patch_id: patch.id },
        order: [['id', 'ASC']],
      });
      const settings = await PatchSetting.findAll({
        where: { patch_id: patch.id },
        order: [['id', 'ASC']],
      });
      // Normalled connections, resolved against THIS patch's cables: each one
      // is active until a cable lands in its target input, and its actual
      // signal is traced through input→input chains to the patched origin.
      const normalizationRows =
        liveIds.size === 0
          ? []
          : await ComponentNormalization.findAll({
              where: { module_id: [...liveIds] },
              order: [['id', 'ASC']],
            });
      const normalizationsByModule = new Map();
      for (const n of normalizationRows) {
        if (!normalizationsByModule.has(n.module_id)) normalizationsByModule.set(n.module_id, []);
        normalizationsByModule.get(n.module_id).push(n.get({ plain: true }));
      }
      const plainPatchModules = patchModules.map((pm) => ({
        id: pm.id,
        module_id: pm.module_id !== null && liveIds.has(pm.module_id) ? pm.module_id : null,
      }));
      const plainCables = cables.map((c) => c.get({ plain: true }));
      const normalled = resolveNormalledSignals({
        patchModules: plainPatchModules,
        componentsByModule,
        normalizationsByModule,
        cables: plainCables,
      });
      // Whole-patch signal flow: module-internal routes carry signal across
      // each module, so a generator output can be followed through cables,
      // mults, normals and modules to everywhere it ends up.
      const routeRows =
        liveIds.size === 0
          ? []
          : await ComponentRoute.findAll({
              where: { module_id: [...liveIds] },
              order: [['id', 'ASC']],
            });
      const routesByModule = new Map();
      for (const r of routeRows) {
        if (!routesByModule.has(r.module_id)) routesByModule.set(r.module_id, []);
        routesByModule.get(r.module_id).push(r.get({ plain: true }));
      }
      // Routing switch sections: the common jack connects to one step jack
      // at a time, so the flow tracer draws every cabled step as a selected
      // (not simultaneous) path.
      const switchRows =
        liveIds.size === 0
          ? []
          : await ComponentSwitch.findAll({
              where: { module_id: [...liveIds] },
              order: [['id', 'ASC']],
            });
      const switchStepRows =
        switchRows.length === 0
          ? []
          : await ComponentSwitchStep.findAll({
              where: { switch_id: switchRows.map((s) => s.id) },
              order: [
                ['position', 'ASC'],
                ['component_id', 'ASC'],
              ],
            });
      const switchesByModule = new Map();
      for (const s of switchRows) {
        if (!switchesByModule.has(s.module_id)) switchesByModule.set(s.module_id, []);
        switchesByModule.get(s.module_id).push({
          id: s.id,
          name: s.name,
          common_component_id: s.common_component_id,
          step_component_ids: switchStepRows
            .filter((st) => st.switch_id === s.id)
            .map((st) => st.component_id),
        });
      }
      const flow = buildSignalFlow({
        patchModules: plainPatchModules,
        componentsByModule,
        routesByModule,
        normalizationsByModule,
        switchesByModule,
        cables: plainCables,
      });
      res.json(
        patchJson(patch, {
          modules: patchModules.map((pm) => ({
            id: pm.id,
            module_id: pm.module_id,
            manufacturer: pm.manufacturer,
            module_name: pm.module_name,
            instance: pm.instance,
            // false when the module record has since been deleted — the
            // snapshot row still renders, but has no components to patch.
            live: pm.module_id !== null && liveIds.has(pm.module_id),
            components: componentsByModule.get(pm.module_id) ?? [],
          })),
          cables: cables.map((c) => ({
            id: c.id,
            from_patch_module_id: c.from_patch_module_id,
            from_component_id: c.from_component_id,
            from_component_name: c.from_component_name,
            to_patch_module_id: c.to_patch_module_id,
            to_component_id: c.to_component_id,
            to_component_name: c.to_component_name,
          })),
          settings: settings.map((s) => ({
            id: s.id,
            patch_module_id: s.patch_module_id,
            component_id: s.component_id,
            component_name: s.component_name,
            value: s.value,
          })),
          normalizations: normalled,
          flow,
        })
      );
    } catch (e) {
      next(e);
    }
  });

  // Rename / edit description. Body: { name?, description? }
  router.put('/:id', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const updates = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        updates.name = name;
      }
      if (req.body?.description !== undefined) {
        updates.description = String(req.body.description || '').trim() || null;
      }
      await patch.update(updates);
      res.json(patchJson(patch));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      await patch.destroy();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // The jacks of a module that belong to one of its routing switch sections
  // (common or step). Switch jacks are exempt from the mult rules: an N→1
  // switch legitimately takes cables into several jacks of the section —
  // only one is live at a time, chosen by the switch, not by the patch.
  async function switchMemberIds(moduleId) {
    if (!moduleId) return new Set();
    const sections = await ComponentSwitch.findAll({ where: { module_id: moduleId } });
    const ids = new Set(sections.map((s) => s.common_component_id));
    if (sections.length > 0) {
      const steps = await ComponentSwitchStep.findAll({
        where: { switch_id: sections.map((s) => s.id) },
      });
      for (const st of steps) ids.add(st.component_id);
    }
    return ids;
  }

  // A patch_modules row of this patch, with the component (when given)
  // verified to belong to the snapshot's live module.
  async function resolveEndpoint(patch, patchModuleId, componentId) {
    const pm = await PatchModule.findOne({
      where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
    });
    if (!pm) return { error: 'that module is not part of this patch' };
    const component = await ModuleComponent.findOne({
      where: { id: Number(componentId) || 0, module_id: pm.module_id ?? 0 },
    });
    if (!component) return { error: 'that component does not belong to this module' };
    return { pm, component };
  }

  // Plug a cable: an output jack into an input jack. Body:
  // { from_patch_module_id, from_component_id, to_patch_module_id, to_component_id }
  router.post('/:id/cables', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const from = await resolveEndpoint(
        patch,
        req.body?.from_patch_module_id,
        req.body?.from_component_id
      );
      if (from.error) return res.status(400).json({ error: `from: ${from.error}` });
      const to = await resolveEndpoint(
        patch,
        req.body?.to_patch_module_id,
        req.body?.to_component_id
      );
      if (to.error) return res.status(400).json({ error: `to: ${to.error}` });
      // A bidirectional (mult) jack can sit at either end of a cable — its
      // role in this patch is decided by which end it is.
      const BIDIRECTIONAL = 'bidirectional_jack';
      if (from.component.type !== 'output_jack' && from.component.type !== BIDIRECTIONAL) {
        return res.status(400).json({ error: 'a cable must start at an output or mult jack' });
      }
      if (to.component.type !== 'input_jack' && to.component.type !== BIDIRECTIONAL) {
        return res.status(400).json({ error: 'a cable must end at an input or mult jack' });
      }
      // The interchangeable jacks of one mult section: same module, same
      // group label (ungrouped bidirectional jacks count as one group).
      const groupKey = (c) => (c.group_label || '').trim().toLowerCase();
      // Switch-section jacks opt out of every mult rule below.
      const fromSwitchJacks =
        from.component.type === BIDIRECTIONAL
          ? await switchMemberIds(from.pm.module_id)
          : new Set();
      const toSwitchJacks =
        to.component.type === BIDIRECTIONAL ? await switchMemberIds(to.pm.module_id) : new Set();
      const sameMultGroup = (a, b) =>
        a.type === BIDIRECTIONAL &&
        b.type === BIDIRECTIONAL &&
        !fromSwitchJacks.has(a.id) &&
        !toSwitchJacks.has(b.id) &&
        groupKey(a) === groupKey(b);
      if (from.pm.id === to.pm.id && sameMultGroup(from.component, to.component)) {
        return res
          .status(400)
          .json({ error: 'both jacks belong to the same mult group — that cable does nothing' });
      }
      const existing = await PatchCable.findAll({ where: { patch_id: patch.id } });
      // An input takes exactly one cable; the same output may fan out via
      // multiples/stackcables, but not twice into the same input.
      const inputTaken = existing.some(
        (c) => c.to_patch_module_id === to.pm.id && c.to_component_id === to.component.id
      );
      if (inputTaken) {
        return res.status(409).json({
          error: `'${to.component.name}' on ${to.pm.manufacturer} ${to.pm.module_name} already has a cable in it`,
        });
      }
      // Mult rules. Cabling INTO a bidirectional jack makes it its group's
      // input, so the jack must not already carry a copy out, and the group
      // must not already have an input on another jack.
      if (to.component.type === BIDIRECTIONAL && !toSwitchJacks.has(to.component.id)) {
        if (
          existing.some(
            (c) => c.from_patch_module_id === to.pm.id && c.from_component_id === to.component.id
          )
        ) {
          return res.status(409).json({
            error: `'${to.component.name}' is already carrying a copy out of the mult`,
          });
        }
        const groupJacks = (
          await ModuleComponent.findAll({
            where: { module_id: to.pm.module_id, type: BIDIRECTIONAL },
          })
        ).filter((j) => !toSwitchJacks.has(j.id) && groupKey(j) === groupKey(to.component));
        const groupIds = new Set(groupJacks.map((j) => j.id));
        const groupInput = existing.find(
          (c) => c.to_patch_module_id === to.pm.id && groupIds.has(c.to_component_id)
        );
        if (groupInput) {
          return res.status(409).json({
            error: `this mult group already takes its input at '${groupInput.to_component_name}'`,
          });
        }
      }
      // ... and cabling OUT of one only works while the jack is not already
      // the group's input.
      if (
        from.component.type === BIDIRECTIONAL &&
        !fromSwitchJacks.has(from.component.id) &&
        existing.some(
          (c) => c.to_patch_module_id === from.pm.id && c.to_component_id === from.component.id
        )
      ) {
        return res.status(409).json({
          error: `'${from.component.name}' is already the mult group's input — copies come out of the other jacks`,
        });
      }
      const cable = await PatchCable.create({
        patch_id: patch.id,
        from_patch_module_id: from.pm.id,
        from_component_id: from.component.id,
        from_component_name: from.component.name,
        to_patch_module_id: to.pm.id,
        to_component_id: to.component.id,
        to_component_name: to.component.name,
      });
      res.status(201).json({
        id: cable.id,
        from_patch_module_id: cable.from_patch_module_id,
        from_component_id: cable.from_component_id,
        from_component_name: cable.from_component_name,
        to_patch_module_id: cable.to_patch_module_id,
        to_component_id: cable.to_component_id,
        to_component_name: cable.to_component_name,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/cables/:cableId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const deleted = await PatchCable.destroy({
        where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Cable not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Record how a control is dialed in for this patch (upsert per module
  // instance + component). Body: { patch_module_id, component_id, value }
  router.put('/:id/settings', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const target = await resolveEndpoint(patch, req.body?.patch_module_id, req.body?.component_id);
      if (target.error) return res.status(400).json({ error: target.error });
      if (target.component.type.endsWith('_jack')) {
        return res.status(400).json({ error: 'jacks are patched with cables, not settings' });
      }
      const value = String(req.body?.value ?? '').trim();
      if (!value) return res.status(400).json({ error: 'value is required' });
      const existing = await PatchSetting.findOne({
        where: {
          patch_id: patch.id,
          patch_module_id: target.pm.id,
          component_id: target.component.id,
        },
      });
      const setting = existing
        ? await existing.update({ value })
        : await PatchSetting.create({
            patch_id: patch.id,
            patch_module_id: target.pm.id,
            component_id: target.component.id,
            component_name: target.component.name,
            value,
          });
      res.status(existing ? 200 : 201).json({
        id: setting.id,
        patch_module_id: setting.patch_module_id,
        component_id: setting.component_id,
        component_name: setting.component_name,
        value: setting.value,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/settings/:settingId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const deleted = await PatchSetting.destroy({
        where: { id: Number(req.params.settingId) || 0, patch_id: patch.id },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Setting not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
