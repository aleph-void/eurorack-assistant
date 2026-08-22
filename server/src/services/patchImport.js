// Reading a patch file back in, here or on somebody else's install.
//
// The names in the document are resolved against the modules the importing
// user actually has, and what cannot be resolved is kept as a name. That is
// not a fallback bolted on here: patch_modules.module_id and the component
// ids on cables are nullable exactly so a patch survives modules it cannot
// see, which is what makes a patch from a stranger's rack render at all.
//
// Only modules the user OWNS are resolved: a name that matches a module
// record they do not own stays a name, so importing a patch never quietly
// hands anybody a module they have not imported.

import { snapshotRackLayout } from './patchLayout.js';
import { freePatchName } from './patchNames.js';

async function resolveModules(db, userId, documentModules) {
  const { Module, Rack, RackModule, ModuleComponent, ModuleParameter } = db.models;
  const key = (manufacturer, name) =>
    `${String(manufacturer ?? '').trim().toLowerCase()}|${String(name ?? '').trim().toLowerCase()}`;

  const wanted = new Set(documentModules.map((m) => key(m.manufacturer, m.module_name)));
  const mappings = await RackModule.findAll({
    include: [
      { model: Rack, where: { user_id: userId }, attributes: [] },
      { model: Module, attributes: ['id', 'manufacturer', 'name'] },
    ],
  });
  const byName = new Map();
  for (const rm of mappings) {
    if (!rm.Module) continue;
    const k = key(rm.Module.manufacturer, rm.Module.name);
    if (wanted.has(k) && !byName.has(k)) byName.set(k, rm.Module.id);
  }

  // The components of every module that resolved, so cable ends and settings
  // can be matched to real rows by name.
  const moduleIds = [...new Set(byName.values())];
  const components = moduleIds.length
    ? await ModuleComponent.findAll({
        where: { module_id: moduleIds },
        attributes: ['id', 'module_id', 'name', 'type'],
      })
    : [];
  const componentsByModule = new Map();
  for (const c of components) {
    if (!componentsByModule.has(c.module_id)) componentsByModule.set(c.module_id, new Map());
    const names = componentsByModule.get(c.module_id);
    const lower = c.name.trim().toLowerCase();
    // A label can identify several physical controls. Type makes the identity
    // unambiguous in new patch files; the name-only entry preserves imports of
    // files written before types were included.
    if (!names.has(lower)) names.set(lower, c.id);
    names.set(`${lower}\u0000${c.type}`, c.id);
  }

  // The menu parameters of the same modules, keyed by the component they hang
  // off and their name, so a setting of "OUT 1"'s "Clock division" finds the
  // row it means and not the identically named parameter of "OUT 2".
  const parameters = moduleIds.length
    ? await ModuleParameter.findAll({
        where: { module_id: moduleIds },
        attributes: ['id', 'module_id', 'component_id', 'name'],
      })
    : [];
  const parametersByModule = new Map();
  for (const p of parameters) {
    if (!parametersByModule.has(p.module_id)) parametersByModule.set(p.module_id, new Map());
    parametersByModule
      .get(p.module_id)
      .set(`${p.component_id ?? 0}\u0000${String(p.name).trim().toLowerCase()}`, p.id);
  }

  return documentModules.map((m) => {
    // Off-rack gear declares its own connection points and never stands for a
    // module record, however it happens to be named.
    const moduleId = m.external ? null : (byName.get(key(m.manufacturer, m.module_name)) ?? null);
    return {
      ...m,
      module_id: moduleId,
      components: moduleId === null ? new Map() : (componentsByModule.get(moduleId) ?? new Map()),
      parameters: moduleId === null ? new Map() : (parametersByModule.get(moduleId) ?? new Map()),
    };
  });
}

// Write a parsed document as a patch belonging to userId. `rack` is the user's
// rack the patch should be filed against, or null to keep the document's rack
// name and no rack.
export async function importPatchDocument(db, { userId, document, rack = null, name = null }) {
  const {
    Patch,
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;

  const resolved = await resolveModules(db, userId, document.modules);
  const byRef = new Map(resolved.map((m) => [m.ref, m]));

  // Patch names are one per account (services/patchNames.js). The importer
  // may have typed one, in which case the route has already checked they can
  // have it; the name that comes out of the file is the app's own choice, so
  // it takes the next free one — reading the same file in twice is a second
  // copy of the patch, not a refusal.
  const patchName = name || (await freePatchName(db, userId, document.name || 'Imported patch'));

  let patch;
  await db.sequelize.transaction(async (transaction) => {
    patch = await Patch.create(
      {
        user_id: userId,
        rack_id: rack?.id ?? null,
        rack_name: rack?.name ?? document.rack_name ?? 'imported patch',
        // Filing the import under one of your racks makes it a patch of that
        // rack, whatever it was elsewhere. Left unfiled, the document's own
        // system and rack names are kept — they are soft names precisely so
        // a multi-rack patch still reads in an account that has no such
        // system.
        system_name: rack ? null : (document.system_name ?? null),
        name: patchName,
        description: document.description,
      },
      { transaction }
    );

    // Buses first: instances point at them.
    const groupIds = new Map();
    for (const g of document.groups) {
      const created = await PatchGroup.create({ ...g, patch_id: patch.id }, { transaction });
      groupIds.set(g.name, created.id);
    }

    // Filed under one of the user's racks, the import copies that rack's
    // arrangement as it stands now — the same thing creating a patch from
    // the rack does. An unfiled import has no studio to copy.
    if (rack) await snapshotRackLayout(db, patch, [rack], { transaction });

    // Instances, then the connection points declared on them.
    const rowIds = new Map();
    const portIds = new Map();
    for (const m of resolved) {
      const created = await PatchModule.create(
        {
          patch_id: patch.id,
          module_id: m.module_id,
          manufacturer: m.manufacturer,
          module_name: m.module_name,
          instance: m.instance,
          rack_id: rack?.id ?? null,
          rack_name: rack?.name ?? m.rack_name ?? null,
          label: m.label,
          external: m.external,
          group_id: m.group === null ? null : (groupIds.get(m.group) ?? null),
        },
        { transaction }
      );
      rowIds.set(m.ref, created.id);
      const ports = new Map();
      for (const p of m.ports) {
        const port = await PatchModulePort.create(
          { ...p, patch_module_id: created.id },
          { transaction }
        );
        ports.set(p.name.trim().toLowerCase(), port.id);
      }
      portIds.set(m.ref, ports);
    }

    // A jack name against one instance: the component row when the instance is
    // a module this user has, the declared port when it is not, and nothing at
    // all when the name matches neither — in which case the name alone is what
    // the patch shows, which is exactly what it does for a module that was
    // deleted underneath it.
    const jackId = (ref, jackName, type = null) => {
      const lower = String(jackName ?? '').trim().toLowerCase();
      const m = byRef.get(ref);
      if (!m) return null;
      if (m.module_id !== null) return m.components.get(type ? `${lower}\u0000${type}` : lower) ?? null;
      return portIds.get(ref)?.get(lower) ?? null;
    };

    // A menu parameter of the module an instance resolved to, by the jack it
    // belongs to and its name.
    const parameterId = (ref, componentId, parameterName) => {
      const m = byRef.get(ref);
      if (!m || m.module_id === null) return null;
      const lower = String(parameterName ?? '').trim().toLowerCase();
      return m.parameters.get(`${componentId ?? 0}\u0000${lower}`) ?? null;
    };

    for (const c of document.cables) {
      await PatchCable.create(
        {
          patch_id: patch.id,
          from_patch_module_id: rowIds.get(c.from.module),
          from_component_id: jackId(c.from.module, c.from.jack, c.from.type),
          from_component_name: c.from.jack,
          to_patch_module_id: rowIds.get(c.to.module),
          to_component_id: jackId(c.to.module, c.to.jack, c.to.type),
          to_component_name: c.to.jack,
          note: c.note,
          optional: c.optional,
          stacked: c.stacked,
          alt_group: c.alt_group,
        },
        { transaction }
      );
    }

    for (const s of document.settings) {
      const componentId = s.control ? jackId(s.module, s.control, s.type) : null;
      await PatchSetting.create(
        {
          patch_id: patch.id,
          patch_module_id: rowIds.get(s.module),
          component_id: componentId,
          component_name: s.control,
          // Matched by name against the menu of the module that resolved,
          // like everything else in a patch file: a parameter that no longer
          // exists (or a module that did not resolve) keeps its name and
          // loses only the live reference.
          parameter_id: s.parameter ? parameterId(s.module, componentId, s.parameter) : null,
          parameter_name: s.parameter,
          value: s.value,
        },
        { transaction }
      );
    }

    for (const l of document.links) {
      const created = await PatchModuleLink.create(
        {
          patch_id: patch.id,
          a_patch_module_id: rowIds.get(l.a),
          b_patch_module_id: rowIds.get(l.b),
          kind: l.kind,
          description: l.description,
        },
        { transaction }
      );
      for (const j of l.jacks) {
        await PatchModuleLinkJack.create(
          {
            link_id: created.id,
            a_component_id: jackId(l.a, j.a, j.a_type),
            a_component_name: j.a,
            b_component_id: jackId(l.b, j.b, j.b_type),
            b_component_name: j.b,
          },
          { transaction }
        );
      }
    }
  });

  // What the importer could not place. Not an error — the patch renders by
  // name — but the one thing the person doing it needs to be told.
  const unresolved = resolved
    .filter((m) => !m.external && m.module_id === null)
    .map((m) => `${m.manufacturer} ${m.module_name}`.trim());

  return {
    patch,
    counts: {
      modules: resolved.length,
      cables: document.cables.length,
      settings: document.settings.length,
      groups: document.groups.length,
      links: document.links.length,
    },
    unresolved_modules: [...new Set(unresolved)],
  };
}
