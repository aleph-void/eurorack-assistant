import { Router } from 'express';
import { Op } from 'sequelize';
import {
  loadPatchDetail as loadPatchDetailFor,
  patchJson,
} from '../../services/patchDetail.js';
import { readableResource, removeShares } from '../../services/sharing.js';
import { requireOwnedPatch } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

// The patch records themselves: list, create from a rack, full detail,
// habit-learned cable suggestions, rename, delete and clone.
export function patchCoreRoutes(db) {
  const {
    System,
    Rack,
    RackModule,
    Module,
    ModuleComponent,
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

  router.get('/', asyncHandler(async (req, res) => {
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
  }));

  // Create a patch from one of the user's racks, or from a whole system —
  // every rack in it at once, so a cable can run from any jack on any of
  // those racks to any jack on any other. Either way the contents are
  // snapshotted as they stand. Body: { rack_id | system_id, name,
  // description? }
  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const wantsSystem =
      req.body?.system_id !== undefined &&
      req.body?.system_id !== null &&
      req.body?.system_id !== '';
    let system = null;
    let racks;
    if (wantsSystem) {
      system = await System.findOne({
        where: { id: Number(req.body.system_id) || 0, user_id: req.user.id },
      });
      if (!system) return res.status(404).json({ error: 'System not found' });
      racks = await Rack.findAll({
        where: { system_id: system.id },
        order: [
          ['system_position', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      if (racks.length === 0) {
        return res.status(400).json({ error: 'this system has no racks to patch' });
      }
    } else {
      const rack = await Rack.findOne({
        where: { id: Number(req.body?.rack_id) || 0, user_id: req.user.id },
      });
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      racks = [rack];
    }
    const rackById = new Map(racks.map((rack) => [rack.id, rack]));
    const mappings = await RackModule.findAll({
      where: { rack_id: racks.map((rack) => rack.id) },
      include: [Module],
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
      ],
    });
    if (mappings.length === 0) {
      return res.status(400).json({
        error: system ? 'this system has no modules to patch' : 'this rack has no modules to patch',
      });
    }
    const description = String(req.body?.description || '').trim();
    // One patch_modules row per module INSTANCE: quantity 2 becomes
    // instance 1 and instance 2 so cables can tell them apart. Across a
    // system the numbering keeps running, so the same module in two racks
    // still gets distinct instance numbers — the rack columns say which
    // copy stands where.
    const instanceCounts = new Map();
    const snapshot = mappings.flatMap((rm) => {
      const rack = rackById.get(rm.rack_id);
      return Array.from({ length: Math.max(1, rm.quantity) }, () => {
        const instance = (instanceCounts.get(rm.Module.id) ?? 0) + 1;
        instanceCounts.set(rm.Module.id, instance);
        return {
          module_id: rm.Module.id,
          manufacturer: rm.Module.manufacturer,
          module_name: rm.Module.name,
          instance,
          rack_id: rack?.id ?? null,
          rack_name: rack?.name ?? null,
        };
      });
    });
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
          // A system patch is not filed under any one rack; rack_name is
          // NOT NULL and reads as the thing the patch was built from, so
          // the system's name stands in it as well as in system_name.
          rack_id: system ? null : racks[0].id,
          rack_name: system ? system.name : racks[0].name,
          system_id: system?.id ?? null,
          system_name: system?.name ?? null,
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
  }));

  // Full detail: the snapshot instances (with each live module's components
  // and their valid values joined in), the cables, settings, groups, links,
  // and the traced normalled connections and signal flow.
  // Yours, or one somebody shared with you. A shared patch is readable and
  // nothing more: every route below finds the patch under its owner, so a
  // reader gets the picture and the owner keeps the patch.
  router.get('/:id', asyncHandler(async (req, res) => {
    const found = await readableResource(db, req.user.id, 'patch', req.params.id);
    if (!found) return res.status(404).json({ error: 'Patch not found' });
    const patch = found.row;
    // A share recipient gets the patch itself but not the private layout of
    // the rack it sits in (racks are shared separately, if at all).
    const { json } = await loadPatchDetailFor(db, patch, { includeRackLayout: !found.shared });
    const owner = found.shared ? await db.models.User.findByPk(patch.user_id) : null;
    res.json(
      patchJson(patch, {
        ...json,
        shared: found.shared,
        owner_username: owner?.username ?? req.user.username,
      })
    );
  }));

  // Cables worth plugging next, learned from the user's other patches.
  //
  // A rack is patched in habits: the same VCO output into the same filter,
  // the same envelope into the same VCA. Every cable in the user's other
  // patches is reduced to (module, jack) → (module, jack) — which survives
  // being a different patch of a different rack — counted by how many patches
  // it appears in, and resolved back onto THIS patch's instances. Anything
  // already patched here, and any input that already has a cable in it, is
  // dropped: a suggestion you cannot act on is noise.
  router.get('/:id/suggestions', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;

    const mine = await PatchModule.findAll({
      where: { patch_id: patch.id },
      order: [['id', 'ASC']],
    });
    const myCables = await PatchCable.findAll({ where: { patch_id: patch.id } });
    const others = await Patch.findAll({
      where: { user_id: req.user.id, id: { [Op.ne]: patch.id } },
      attributes: ['id'],
    });
    const otherIds = others.map((p) => p.id);
    if (otherIds.length === 0 || mine.length === 0) return res.json({ suggestions: [] });

    const otherModules = await PatchModule.findAll({ where: { patch_id: otherIds } });
    const otherCables = await PatchCable.findAll({ where: { patch_id: otherIds } });
    const moduleOfInstance = new Map(otherModules.map((pm) => [pm.id, pm.module_id]));

    // One entry per (module, jack) → (module, jack) pair, counting the
    // patches it appears in rather than the cables: a pair stacked twice in
    // one patch is still one habit.
    const habits = new Map();
    for (const c of otherCables) {
      const fromModule = moduleOfInstance.get(c.from_patch_module_id);
      const toModule = moduleOfInstance.get(c.to_patch_module_id);
      if (!fromModule || !toModule || !c.from_component_id || !c.to_component_id) continue;
      const key = `${fromModule}:${c.from_component_id}>${toModule}:${c.to_component_id}`;
      if (!habits.has(key)) {
        habits.set(key, {
          from_module_id: fromModule,
          from_component_id: c.from_component_id,
          to_module_id: toModule,
          to_component_id: c.to_component_id,
          patches: new Set(),
        });
      }
      habits.get(key).patches.add(c.patch_id);
    }
    if (habits.size === 0) return res.json({ suggestions: [] });

    // Only jacks that still exist: a module re-analyzed since then has new
    // component ids, and a habit pointing at the old ones is stale.
    const componentIds = [
      ...new Set([...habits.values()].flatMap((h) => [h.from_component_id, h.to_component_id])),
    ];
    const components = await ModuleComponent.findAll({ where: { id: componentIds } });
    const componentById = new Map(components.map((c) => [c.id, c]));

    const instancesOf = (moduleId) => mine.filter((pm) => pm.module_id === moduleId);
    const cableInto = (pmId, componentId) =>
      myCables.some((c) => c.to_patch_module_id === pmId && c.to_component_id === componentId);
    const alreadyPatched = (fromPm, fromId, toPm, toId) =>
      myCables.some(
        (c) =>
          c.from_patch_module_id === fromPm &&
          c.from_component_id === fromId &&
          c.to_patch_module_id === toPm &&
          c.to_component_id === toId
      );

    const suggestions = [];
    for (const habit of habits.values()) {
      const fromComponent = componentById.get(habit.from_component_id);
      const toComponent = componentById.get(habit.to_component_id);
      if (!fromComponent || !toComponent) continue;
      if (fromComponent.module_id !== habit.from_module_id) continue;
      if (toComponent.module_id !== habit.to_module_id) continue;
      const fromInstance = instancesOf(habit.from_module_id)[0];
      // The first instance whose input is still free — a second Optomix is
      // exactly where the next copy of a habitual cable goes.
      const toInstance = instancesOf(habit.to_module_id).find(
        (pm) => !cableInto(pm.id, habit.to_component_id)
      );
      if (!fromInstance || !toInstance) continue;
      if (fromInstance.id === toInstance.id && fromComponent.id === toComponent.id) continue;
      if (alreadyPatched(fromInstance.id, fromComponent.id, toInstance.id, toComponent.id)) {
        continue;
      }
      suggestions.push({
        from_patch_module_id: fromInstance.id,
        from_component_id: fromComponent.id,
        from_component_name: fromComponent.name,
        to_patch_module_id: toInstance.id,
        to_component_id: toComponent.id,
        to_component_name: toComponent.name,
        patches: habit.patches.size,
      });
    }
    suggestions.sort(
      (a, b) =>
        b.patches - a.patches ||
        a.from_patch_module_id - b.from_patch_module_id ||
        a.from_component_name.localeCompare(b.from_component_name)
    );
    res.json({ suggestions: suggestions.slice(0, 8) });
  }));

  // Rename / edit description. Body: { name?, description? }
  router.put('/:id', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
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
  }));

  router.delete('/:id', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const patch = req.patch;
    await patch.destroy();
    await removeShares(db, 'patch', patch.id);
    res.json({ ok: true });
  }));

  // Copy a patch, whole: the same instances, cables, settings, buses, links
  // and declared connection points under a new name. This is how a patch
  // becomes a starting point — a house voice you build variations on, or a
  // template you keep and never touch again.
  //
  // Every id inside a patch is rewritten, including the connection points
  // declared on instances with no live module: patch_module_ports live in the
  // same id namespace as module components, so a cable end on such an
  // instance is remapped to the copied port rather than left pointing at the
  // original patch's row.
  // Body: { name? }
  router.post('/:id/clone', requireOwnedPatch(db), asyncHandler(async (req, res) => {
    const source = req.patch;
    const name = String(req.body?.name || '').trim() || `${source.name} (copy)`;

    const where = { patch_id: source.id };
    const modules = await PatchModule.findAll({ where, order: [['id', 'ASC']] });
    const [groups, ports, cables, settings, links] = await Promise.all([
      PatchGroup.findAll({ where, order: [['id', 'ASC']] }),
      modules.length === 0
        ? []
        : PatchModulePort.findAll({
            where: { patch_module_id: modules.map((pm) => pm.id) },
            order: [['id', 'ASC']],
          }),
      PatchCable.findAll({ where, order: [['id', 'ASC']] }),
      PatchSetting.findAll({ where, order: [['id', 'ASC']] }),
      PatchModuleLink.findAll({ where, order: [['id', 'ASC']] }),
    ]);
    const linkJacks =
      links.length === 0
        ? []
        : await PatchModuleLinkJack.findAll({
            where: { link_id: links.map((l) => l.id) },
            order: [['id', 'ASC']],
          });

    let copy;
    await db.sequelize.transaction(async (transaction) => {
      copy = await Patch.create(
        {
          user_id: req.user.id,
          rack_id: source.rack_id,
          rack_name: source.rack_name,
          system_id: source.system_id,
          system_name: source.system_name,
          name,
          description: source.description,
        },
        { transaction }
      );

      // Buses first: instances point at them.
      const groupMap = new Map();
      for (const g of groups) {
        const created = await PatchGroup.create(
          {
            patch_id: copy.id,
            name: g.name,
            description: g.description,
            position: g.position,
          },
          { transaction }
        );
        groupMap.set(g.id, created.id);
      }

      const moduleMap = new Map();
      for (const pm of modules) {
        const created = await PatchModule.create(
          {
            patch_id: copy.id,
            module_id: pm.module_id,
            manufacturer: pm.manufacturer,
            module_name: pm.module_name,
            instance: pm.instance,
            rack_id: pm.rack_id,
            rack_name: pm.rack_name,
            label: pm.label,
            external: pm.external,
            group_id: pm.group_id === null ? null : (groupMap.get(pm.group_id) ?? null),
          },
          { transaction }
        );
        moduleMap.set(pm.id, created.id);
      }

      // Connection points declared inside the patch, and the map that
      // rewrites cable ends referring to them.
      const portMap = new Map();
      for (const p of ports) {
        const created = await PatchModulePort.create(
          {
            patch_module_id: moduleMap.get(p.patch_module_id),
            name: p.name,
            type: p.type,
            port_kind: p.port_kind,
            description: p.description,
            position: p.position,
          },
          { transaction }
        );
        portMap.set(p.id, created.id);
      }
      // A component id belongs to the ports table only when its instance
      // has no analyzed module behind it.
      const declared = new Set(modules.filter((pm) => !pm.module_id).map((pm) => pm.id));
      const componentIdIn = (patchModuleId, componentId) =>
        declared.has(patchModuleId) && portMap.has(componentId)
          ? portMap.get(componentId)
          : componentId;

      for (const c of cables) {
        await PatchCable.create(
          {
            patch_id: copy.id,
            from_patch_module_id: moduleMap.get(c.from_patch_module_id),
            from_component_id: componentIdIn(c.from_patch_module_id, c.from_component_id),
            from_component_name: c.from_component_name,
            to_patch_module_id: moduleMap.get(c.to_patch_module_id),
            to_component_id: componentIdIn(c.to_patch_module_id, c.to_component_id),
            to_component_name: c.to_component_name,
            note: c.note,
            optional: c.optional,
            stacked: c.stacked,
            alt_group: c.alt_group,
          },
          { transaction }
        );
      }

      for (const s of settings) {
        await PatchSetting.create(
          {
            patch_id: copy.id,
            patch_module_id: moduleMap.get(s.patch_module_id),
            component_id: s.component_id,
            component_name: s.component_name,
            value: s.value,
          },
          { transaction }
        );
      }

      for (const link of links) {
        const created = await PatchModuleLink.create(
          {
            patch_id: copy.id,
            a_patch_module_id: moduleMap.get(link.a_patch_module_id),
            b_patch_module_id: moduleMap.get(link.b_patch_module_id),
            kind: link.kind,
            description: link.description,
          },
          { transaction }
        );
        for (const jack of linkJacks.filter((j) => j.link_id === link.id)) {
          await PatchModuleLinkJack.create(
            {
              link_id: created.id,
              a_component_id: componentIdIn(link.a_patch_module_id, jack.a_component_id),
              a_component_name: jack.a_component_name,
              b_component_id: componentIdIn(link.b_patch_module_id, jack.b_component_id),
              b_component_name: jack.b_component_name,
            },
            { transaction }
          );
        }
      }
    });

    res.status(201).json(
      patchJson(copy, {
        module_count: modules.length,
        cable_count: cables.length,
        cloned_from: source.id,
      })
    );
  }));

  return router;
}
