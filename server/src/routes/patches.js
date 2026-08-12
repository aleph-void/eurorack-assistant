import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import {
  cableJson,
  componentJson,
  loadPatchDetail as loadPatchDetailFor,
  moduleJson,
  patchJson,
  portJson,
} from '../services/patchDetail.js';
import { PORT_KINDS } from '../services/manualAnalyzer.js';

// A user's patches. A patch is created FROM a rack but owns a snapshot of the
// rack's contents (patch_modules, one row per module instance): modules can
// move to other racks, be re-analyzed (rewriting their components under new
// ids) or be deleted afterwards, and the patch keeps showing the rack as it
// was. Live module/component rows are joined in at read time for as long as
// they exist — the denormalized name columns take over when they don't.
//
// A patch is not limited to that snapshot, because real patches are not:
// instances carry labels and belong to named buses, off-rack gear (a DAW, a
// MIDI interface, the PA) and modules the rack does not hold take part with
// connection points declared inside the patch, and instances can be wired to
// each other without patch cables — a host and its expander panel, or a pair
// of modules bridging two cases.
//
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
    ComponentPair,
    ModuleExpander,
    Patch,
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const JACK_TYPES = ['input_jack', 'output_jack', 'bidirectional_jack'];
  const LINK_KINDS = ['expander', 'bridge'];
  // A jack with no port_kind is an ordinary eurorack 3.5mm patch point; a
  // cable only ever joins two connections of the same kind.
  const portKind = (component) => component.port_kind || 'eurorack';

  function ownPatch(userId, id) {
    return Patch.findOne({ where: { id: Number(id) || 0, user_id: userId } });
  }

  const loadPatchDetail = (patch) => loadPatchDetailFor(db, patch);

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
      // Hosts and expanders in the same rack arrive already wired together —
      // that is what the ribbon cable does — so the patch links them without
      // being asked, instance by instance.
      const rackModuleIds = [...new Set(snapshot.map((s) => s.module_id))];
      const expanderPairs = await ModuleExpander.findAll({
        where: {
          host_module_id: rackModuleIds,
          expander_module_id: rackModuleIds,
        },
      });
      let patch;
      let created = [];
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
        created = await PatchModule.findAll({
          where: { patch_id: patch.id },
          order: [['id', 'ASC']],
          transaction,
        });
        const instancesOf = (moduleId) => created.filter((pm) => pm.module_id === moduleId);
        const linkRows = [];
        for (const pair of expanderPairs) {
          const hosts = instancesOf(pair.host_module_id);
          const expanders = instancesOf(pair.expander_module_id);
          // Pair them off in order; a spare panel on either side is left
          // unlinked for the user to wire up by hand.
          for (let i = 0; i < Math.min(hosts.length, expanders.length); i += 1) {
            linkRows.push({
              patch_id: patch.id,
              a_patch_module_id: hosts[i].id,
              b_patch_module_id: expanders[i].id,
              kind: 'expander',
            });
          }
        }
        if (linkRows.length > 0) await PatchModuleLink.bulkCreate(linkRows, { transaction });
      });
      res.status(201).json(patchJson(patch, { module_count: snapshot.length, cable_count: 0 }));
    } catch (e) {
      next(e);
    }
  });

  // Full detail: the snapshot instances (with each live module's components
  // and their valid values joined in), the cables, settings, groups, links,
  // and the traced normalled connections and signal flow.
  router.get('/:id', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const { json } = await loadPatchDetail(patch);
      res.json(patchJson(patch, json));
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

  // ---- instances: labels, groups, ad-hoc modules and external gear ----

  // Add something to the patch that the rack snapshot does not hold:
  //   { module_id }                        — another instance of a module you
  //                                          have racked (a second Batumi)
  //   { manufacturer, module_name }        — a module the rack does not hold
  //                                          (a borrowed A-140)
  //   { name, external: true }             — off-rack gear: a DAW, a MIDI
  //                                          interface, the monitors
  // Instances with no live module behind them declare their own connection
  // points with POST /:id/modules/:pmId/ports.
  router.post('/:id/modules', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const external = Boolean(req.body?.external);
      let manufacturer = String(req.body?.manufacturer || '').trim();
      let moduleName = String(req.body?.module_name || req.body?.name || '').trim();
      let moduleId = null;

      if (req.body?.module_id !== undefined && req.body?.module_id !== null && !external) {
        // Only modules the user actually has racked can be referenced live.
        const mapping = await RackModule.findOne({
          where: { module_id: Number(req.body.module_id) || 0 },
          include: [{ model: Rack, where: { user_id: req.user.id } }, Module],
        });
        if (!mapping || !mapping.Module) {
          return res.status(400).json({ error: 'module_id must be a module in one of your racks' });
        }
        moduleId = mapping.Module.id;
        manufacturer = mapping.Module.manufacturer;
        moduleName = mapping.Module.name;
      }
      if (!moduleName) {
        return res
          .status(400)
          .json({ error: 'module_id, or a name for the module or piece of gear, is required' });
      }
      const instances = await PatchModule.findAll({
        where: { patch_id: patch.id },
      });
      const instance = moduleId
        ? instances.filter((pm) => pm.module_id === moduleId).length + 1
        : instances.filter(
            (pm) =>
              pm.module_id === null &&
              pm.module_name.toLowerCase() === moduleName.toLowerCase() &&
              (pm.manufacturer || '').toLowerCase() === manufacturer.toLowerCase()
          ).length + 1;
      const pm = await PatchModule.create({
        patch_id: patch.id,
        module_id: moduleId,
        manufacturer: manufacturer || (external ? 'external' : ''),
        module_name: moduleName,
        instance,
        external,
        label: String(req.body?.label || '').trim() || null,
      });
      res.status(201).json(moduleJson(pm, { live: Boolean(moduleId), components: [] }));
    } catch (e) {
      next(e);
    }
  });

  async function ownPatchModule(patch, patchModuleId) {
    return PatchModule.findOne({
      where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
    });
  }

  // Name an instance's role in this patch and file it under a bus/layer.
  // Body: { label?, group_id? } (group_id null clears it)
  router.put('/:id/modules/:pmId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const pm = await ownPatchModule(patch, req.params.pmId);
      if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
      const updates = {};
      if (req.body?.label !== undefined) {
        updates.label = String(req.body.label || '').trim() || null;
      }
      if (req.body?.group_id !== undefined) {
        if (req.body.group_id === null || req.body.group_id === '') {
          updates.group_id = null;
        } else {
          const group = await PatchGroup.findOne({
            where: { id: Number(req.body.group_id) || 0, patch_id: patch.id },
          });
          if (!group) return res.status(400).json({ error: 'group_id must be a group of this patch' });
          updates.group_id = group.id;
        }
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'label or group_id is required' });
      }
      await pm.update(updates);
      res.json(moduleJson(pm, { live: pm.module_id !== null, components: [] }));
    } catch (e) {
      next(e);
    }
  });

  // Remove an instance from the patch, along with everything patched into it.
  router.delete('/:id/modules/:pmId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const pm = await ownPatchModule(patch, req.params.pmId);
      if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
      await db.sequelize.transaction(async (transaction) => {
        await PatchCable.destroy({
          where: {
            patch_id: patch.id,
            [Op.or]: [{ from_patch_module_id: pm.id }, { to_patch_module_id: pm.id }],
          },
          transaction,
        });
        await PatchSetting.destroy({ where: { patch_module_id: pm.id }, transaction });
        await PatchModulePort.destroy({ where: { patch_module_id: pm.id }, transaction });
        const links = await PatchModuleLink.findAll({
          where: {
            patch_id: patch.id,
            [Op.or]: [{ a_patch_module_id: pm.id }, { b_patch_module_id: pm.id }],
          },
          transaction,
        });
        if (links.length > 0) {
          await PatchModuleLinkJack.destroy({
            where: { link_id: links.map((l) => l.id) },
            transaction,
          });
          await PatchModuleLink.destroy({ where: { id: links.map((l) => l.id) }, transaction });
        }
        await pm.destroy({ transaction });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Declare a connection point on an instance with no analyzed module behind
  // it. Body: { name, type?, port_kind?, description? }
  router.post('/:id/modules/:pmId/ports', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const pm = await ownPatchModule(patch, req.params.pmId);
      if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
      if (pm.module_id !== null && (await Module.count({ where: { id: pm.module_id } })) > 0) {
        return res.status(400).json({
          error: "this module's connections come from its analyzed components, not from the patch",
        });
      }
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const type = String(req.body?.type || 'input_jack').trim().toLowerCase();
      if (!JACK_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${JACK_TYPES.join(', ')}` });
      }
      const kind = String(req.body?.port_kind || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (kind && !PORT_KINDS.includes(kind)) {
        return res.status(400).json({ error: `port_kind must be one of: ${PORT_KINDS.join(', ')}` });
      }
      const existing = await PatchModulePort.findAll({ where: { patch_module_id: pm.id } });
      if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: `'${name}' is already declared on this module` });
      }
      const port = await PatchModulePort.create({
        patch_module_id: pm.id,
        name,
        type,
        port_kind: kind || null,
        description: String(req.body?.description || '').trim() || null,
        position: existing.length + 1,
      });
      res.status(201).json({ ...portJson(port), patch_module_id: pm.id });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/modules/:pmId/ports/:portId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const pm = await ownPatchModule(patch, req.params.pmId);
      if (!pm) return res.status(404).json({ error: 'Module not found in this patch' });
      const port = await PatchModulePort.findOne({
        where: { id: Number(req.params.portId) || 0, patch_module_id: pm.id },
      });
      if (!port) return res.status(404).json({ error: 'Port not found' });
      await db.sequelize.transaction(async (transaction) => {
        await PatchCable.destroy({
          where: {
            patch_id: patch.id,
            [Op.or]: [
              { from_patch_module_id: pm.id, from_component_id: port.id },
              { to_patch_module_id: pm.id, to_component_id: port.id },
            ],
          },
          transaction,
        });
        await port.destroy({ transaction });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- groups (named buses / layers) ----

  const groupJson = (g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    position: g.position,
  });

  router.post('/:id/groups', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const existing = await PatchGroup.findAll({ where: { patch_id: patch.id } });
      if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: `this patch already has a group named '${name}'` });
      }
      const group = await PatchGroup.create({
        patch_id: patch.id,
        name,
        description: String(req.body?.description || '').trim() || null,
        position: Number(req.body?.position) || existing.length + 1,
      });
      res.status(201).json(groupJson(group));
    } catch (e) {
      next(e);
    }
  });

  router.put('/:id/groups/:groupId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const group = await PatchGroup.findOne({
        where: { id: Number(req.params.groupId) || 0, patch_id: patch.id },
      });
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const updates = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        updates.name = name;
      }
      if (req.body?.description !== undefined) {
        updates.description = String(req.body.description || '').trim() || null;
      }
      if (req.body?.position !== undefined) updates.position = Number(req.body.position) || 0;
      await group.update(updates);
      res.json(groupJson(group));
    } catch (e) {
      next(e);
    }
  });

  // Deleting a group leaves its members in the patch, ungrouped.
  router.delete('/:id/groups/:groupId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const group = await PatchGroup.findOne({
        where: { id: Number(req.params.groupId) || 0, patch_id: patch.id },
      });
      if (!group) return res.status(404).json({ error: 'Group not found' });
      await db.sequelize.transaction(async (transaction) => {
        await PatchModule.update(
          { group_id: null },
          { where: { patch_id: patch.id, group_id: group.id }, transaction }
        );
        await group.destroy({ transaction });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- links between instances (expander panels, bridges) ----

  // Body: { a_patch_module_id, b_patch_module_id, kind: 'expander'|'bridge',
  //         jacks?: [{ a_component_id, b_component_id }], description? }
  // A bridge with no explicit jack list pairs the two panels' jacks by name,
  // which is exactly how a 7Path pair works (jack 4 ↔ jack 4).
  router.post('/:id/links', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const a = await ownPatchModule(patch, req.body?.a_patch_module_id);
      const b = await ownPatchModule(patch, req.body?.b_patch_module_id);
      if (!a || !b) {
        return res.status(400).json({ error: 'both modules must be part of this patch' });
      }
      if (a.id === b.id) {
        return res.status(400).json({ error: 'a module cannot be linked to itself' });
      }
      const kind = String(req.body?.kind || 'expander').trim().toLowerCase();
      if (!LINK_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${LINK_KINDS.join(', ')}` });
      }
      const existing = await PatchModuleLink.findAll({ where: { patch_id: patch.id } });
      if (
        existing.some(
          (l) =>
            (l.a_patch_module_id === a.id && l.b_patch_module_id === b.id) ||
            (l.a_patch_module_id === b.id && l.b_patch_module_id === a.id)
        )
      ) {
        return res.status(409).json({ error: 'these two modules are already linked' });
      }

      const detail = await loadPatchDetail(patch);
      const jacksOf = (pm) =>
        (detail.topology.jacksByPatchModule.get(pm.id) || []).filter((c) => c.type.endsWith('_jack'));
      let jackRows = [];
      if (kind === 'bridge') {
        const requested = Array.isArray(req.body?.jacks) ? req.body.jacks : [];
        const aJacks = jacksOf(a);
        const bJacks = jacksOf(b);
        if (requested.length > 0) {
          for (const pair of requested) {
            const aJack = aJacks.find((c) => c.id === Number(pair?.a_component_id));
            const bJack = bJacks.find((c) => c.id === Number(pair?.b_component_id));
            if (!aJack || !bJack) {
              return res
                .status(400)
                .json({ error: 'every bridged pair must name a jack on each of the two modules' });
            }
            jackRows.push({
              a_component_id: aJack.id,
              a_component_name: aJack.name,
              b_component_id: bJack.id,
              b_component_name: bJack.name,
            });
          }
        } else {
          const byName = new Map(bJacks.map((c) => [c.name.trim().toLowerCase(), c]));
          for (const aJack of aJacks) {
            const bJack = byName.get(aJack.name.trim().toLowerCase());
            if (!bJack) continue;
            jackRows.push({
              a_component_id: aJack.id,
              a_component_name: aJack.name,
              b_component_id: bJack.id,
              b_component_name: bJack.name,
            });
          }
        }
        if (jackRows.length === 0) {
          return res.status(400).json({
            error:
              'a bridge needs at least one pair of jacks — name them explicitly when the two panels use different labels',
          });
        }
      }

      let link;
      await db.sequelize.transaction(async (transaction) => {
        link = await PatchModuleLink.create(
          {
            patch_id: patch.id,
            a_patch_module_id: a.id,
            b_patch_module_id: b.id,
            kind,
            description: String(req.body?.description || '').trim() || null,
          },
          { transaction }
        );
        if (jackRows.length > 0) {
          await PatchModuleLinkJack.bulkCreate(
            jackRows.map((j) => ({ ...j, link_id: link.id })),
            { transaction }
          );
        }
      });
      res.status(201).json({
        id: link.id,
        kind: link.kind,
        a_patch_module_id: link.a_patch_module_id,
        b_patch_module_id: link.b_patch_module_id,
        description: link.description,
        jacks: jackRows,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/links/:linkId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const link = await PatchModuleLink.findOne({
        where: { id: Number(req.params.linkId) || 0, patch_id: patch.id },
      });
      if (!link) return res.status(404).json({ error: 'Link not found' });
      await db.sequelize.transaction(async (transaction) => {
        await PatchModuleLinkJack.destroy({ where: { link_id: link.id }, transaction });
        await link.destroy({ transaction });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- cables ----

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

  // The jacks of an instance that are bridged to another instance. Like
  // switch jacks, these are exempt from the mult rules: a bridge pairs jacks
  // one to one, so several jacks of one panel legitimately take cables — a
  // 7Path's jacks are interchangeable but they are not copies of each other.
  async function bridgeMemberIds(patch, patchModuleId) {
    const links = await PatchModuleLink.findAll({
      where: {
        patch_id: patch.id,
        kind: 'bridge',
        [Op.or]: [{ a_patch_module_id: patchModuleId }, { b_patch_module_id: patchModuleId }],
      },
    });
    if (links.length === 0) return new Set();
    const jacks = await PatchModuleLinkJack.findAll({
      where: { link_id: links.map((l) => l.id) },
    });
    const linkById = new Map(links.map((l) => [l.id, l]));
    const ids = new Set();
    for (const j of jacks) {
      const link = linkById.get(j.link_id);
      if (link.a_patch_module_id === patchModuleId) ids.add(j.a_component_id);
      if (link.b_patch_module_id === patchModuleId) ids.add(j.b_component_id);
    }
    return ids;
  }

  // Every jack of one instance: an analyzed module's components, or the
  // connection points the patch declares on it.
  async function componentsOfPatchModule(pm) {
    if (pm.module_id) {
      const rows = await ModuleComponent.findAll({ where: { module_id: pm.module_id } });
      if (rows.length > 0) return rows.map((c) => componentJson(c));
    }
    const ports = await PatchModulePort.findAll({ where: { patch_module_id: pm.id } });
    return ports.map((p) => portJson(p));
  }

  // A patch_modules row of this patch, with the component (when given)
  // verified to be one of that instance's connection points.
  async function resolveEndpoint(patch, patchModuleId, componentId) {
    const pm = await PatchModule.findOne({
      where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
    });
    if (!pm) return { error: 'that module is not part of this patch' };
    const jacks = await componentsOfPatchModule(pm);
    const component = jacks.find((c) => c.id === (Number(componentId) || 0));
    if (!component) return { error: 'that component does not belong to this module' };
    return { pm, component };
  }

  // Everything that makes one cable legal, given the cables already patched.
  // Returns null when the cable is fine, or { status, error }.
  async function cableProblem(patch, from, to, existing) {
    const BIDIRECTIONAL = 'bidirectional_jack';
    if (from.component.type !== 'output_jack' && from.component.type !== BIDIRECTIONAL) {
      return { status: 400, error: 'a cable must start at an output or mult jack' };
    }
    if (to.component.type !== 'input_jack' && to.component.type !== BIDIRECTIONAL) {
      return { status: 400, error: 'a cable must end at an input or mult jack' };
    }
    // A MIDI socket, a USB port and a 3.5mm patch point do not connect to
    // each other; patch a piece of gear in between instead.
    if (portKind(from.component) !== portKind(to.component)) {
      return {
        status: 400,
        error: `'${from.component.name}' is a ${portKind(from.component).replace(/_/g, ' ')} connection and '${to.component.name}' is a ${portKind(to.component).replace(/_/g, ' ')} one — a cable cannot join them`,
      };
    }
    // The interchangeable jacks of one mult section: same module, same group
    // label (ungrouped bidirectional jacks count as one group).
    const groupKey = (c) => (c.group_label || '').trim().toLowerCase();
    // Switch-section and bridged jacks opt out of every mult rule below.
    const exemptJacks = async (end) => {
      if (end.component.type !== BIDIRECTIONAL) return new Set();
      const ids = await switchMemberIds(end.pm.module_id);
      for (const id of await bridgeMemberIds(patch, end.pm.id)) ids.add(id);
      return ids;
    };
    const fromSwitchJacks = await exemptJacks(from);
    const toSwitchJacks = await exemptJacks(to);
    const sameMultGroup = (a, b) =>
      a.type === BIDIRECTIONAL &&
      b.type === BIDIRECTIONAL &&
      !fromSwitchJacks.has(a.id) &&
      !toSwitchJacks.has(b.id) &&
      groupKey(a) === groupKey(b);
    if (from.pm.id === to.pm.id && sameMultGroup(from.component, to.component)) {
      return {
        status: 400,
        error: 'both jacks belong to the same mult group — that cable does nothing',
      };
    }
    // An input takes exactly one cable; the same output may fan out via
    // multiples/stackcables, but not twice into the same input.
    const inputTaken = existing.some(
      (c) => c.to_patch_module_id === to.pm.id && c.to_component_id === to.component.id
    );
    if (inputTaken) {
      return {
        status: 409,
        error: `'${to.component.name}' on ${to.pm.manufacturer} ${to.pm.module_name} already has a cable in it`,
      };
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
        return {
          status: 409,
          error: `'${to.component.name}' is already carrying a copy out of the mult`,
        };
      }
      const groupJacks = (await componentsOfPatchModule(to.pm)).filter(
        (j) =>
          j.type === BIDIRECTIONAL &&
          !toSwitchJacks.has(j.id) &&
          groupKey(j) === groupKey(to.component)
      );
      const groupIds = new Set(groupJacks.map((j) => j.id));
      const groupInput = existing.find(
        (c) => c.to_patch_module_id === to.pm.id && groupIds.has(c.to_component_id)
      );
      if (groupInput) {
        return {
          status: 409,
          error: `this mult group already takes its input at '${groupInput.to_component_name}'`,
        };
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
      return {
        status: 409,
        error: `'${from.component.name}' is already the mult group's input — copies come out of the other jacks`,
      };
    }
    return null;
  }

  // The other half of a stereo (or other) pair: the jack that carries the
  // signal's second half on the same instance.
  async function pairedJack(pm, component) {
    if (!pm.module_id) return null;
    const pairs = await ComponentPair.findAll({ where: { module_id: pm.module_id } });
    const pair = pairs.find(
      (p) => p.a_component_id === component.id || p.b_component_id === component.id
    );
    if (!pair) return null;
    const otherId = pair.a_component_id === component.id ? pair.b_component_id : pair.a_component_id;
    const jacks = await componentsOfPatchModule(pm);
    return jacks.find((c) => c.id === otherId) ?? null;
  }

  // Plug a cable: an output jack into an input jack. Body:
  // { from_patch_module_id, from_component_id, to_patch_module_id,
  //   to_component_id, note?, optional?, stacked?, alt_group?, pair? }
  // With pair: true and both ends part of a stereo pair, the second cable is
  // plugged at the same time — a stereo connection is one decision.
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

      const extras = {
        note: String(req.body?.note || '').trim() || null,
        optional: Boolean(req.body?.optional),
        stacked: Boolean(req.body?.stacked),
        alt_group: String(req.body?.alt_group || '').trim() || null,
      };

      const existing = await PatchCable.findAll({ where: { patch_id: patch.id } });
      const problem = await cableProblem(patch, from, to, existing);
      if (problem) return res.status(problem.status).json({ error: problem.error });

      // The second half of a stereo connection, when asked for and available.
      let second = null;
      if (req.body?.pair) {
        const fromPartner = await pairedJack(from.pm, from.component);
        const toPartner = await pairedJack(to.pm, to.component);
        if (!fromPartner || !toPartner) {
          return res.status(400).json({
            error: 'both jacks must be part of a recorded pair to patch them as one connection',
          });
        }
        second = {
          from: { pm: from.pm, component: fromPartner },
          to: { pm: to.pm, component: toPartner },
        };
        const secondProblem = await cableProblem(patch, second.from, second.to, existing);
        if (secondProblem) {
          return res
            .status(secondProblem.status)
            .json({ error: `the other half of the pair: ${secondProblem.error}` });
        }
      }

      const row = (end) => ({
        patch_id: patch.id,
        from_patch_module_id: end.from.pm.id,
        from_component_id: end.from.component.id,
        from_component_name: end.from.component.name,
        to_patch_module_id: end.to.pm.id,
        to_component_id: end.to.component.id,
        to_component_name: end.to.component.name,
        ...extras,
      });
      let cable;
      let paired = null;
      await db.sequelize.transaction(async (transaction) => {
        cable = await PatchCable.create(row({ from, to }), { transaction });
        if (second) paired = await PatchCable.create(row(second), { transaction });
      });
      res.status(201).json({ ...cableJson(cable), paired_cable: paired ? cableJson(paired) : null });
    } catch (e) {
      next(e);
    }
  });

  // Annotate a cable: why it is there, whether it is provisional, whether it
  // is stacked onto the source jack, which alternative it belongs to.
  // Body: { note?, optional?, stacked?, alt_group? }
  router.put('/:id/cables/:cableId', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const cable = await PatchCable.findOne({
        where: { id: Number(req.params.cableId) || 0, patch_id: patch.id },
      });
      if (!cable) return res.status(404).json({ error: 'Cable not found' });
      const updates = {};
      if (req.body?.note !== undefined) updates.note = String(req.body.note || '').trim() || null;
      if (req.body?.optional !== undefined) updates.optional = Boolean(req.body.optional);
      if (req.body?.stacked !== undefined) updates.stacked = Boolean(req.body.stacked);
      if (req.body?.alt_group !== undefined) {
        updates.alt_group = String(req.body.alt_group || '').trim() || null;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'note, optional, stacked or alt_group is required' });
      }
      await cable.update(updates);
      res.json(cableJson(cable));
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
