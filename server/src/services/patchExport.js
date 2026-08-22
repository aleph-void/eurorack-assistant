// A patch written out as a file.
//
// The database stores a patch against ids: which module record an instance
// is, which component row a cable end is. None of those ids mean anything
// anywhere else, so the document is written entirely in NAMES —
// manufacturer and model for an instance, the jack's label for a cable end —
// and the instances are numbered within the document so cables, settings and
// links have something short to point at.

import { PATCH_FORMAT, PATCH_FORMAT_VERSION } from './patchDocumentLimits.js';

export async function exportPatchDocument(db, patch) {
  const {
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
    ModuleComponent,
  } = db.models;
  const where = { patch_id: patch.id };
  const [modules, cables, settings, groups, links] = await Promise.all([
    PatchModule.findAll({ where, order: [['id', 'ASC']] }),
    PatchCable.findAll({ where, order: [['id', 'ASC']] }),
    PatchSetting.findAll({ where, order: [['id', 'ASC']] }),
    PatchGroup.findAll({ where, order: [['position', 'ASC'], ['id', 'ASC']] }),
    PatchModuleLink.findAll({ where, order: [['id', 'ASC']] }),
  ]);
  const ports = modules.length
    ? await PatchModulePort.findAll({
        where: { patch_module_id: modules.map((m) => m.id) },
        order: [['position', 'ASC'], ['id', 'ASC']],
      })
    : [];
  const jacks = links.length
    ? await PatchModuleLinkJack.findAll({
        where: { link_id: links.map((l) => l.id) },
        order: [['id', 'ASC']],
      })
    : [];
  const componentIds = [
    ...cables.flatMap((c) => [c.from_component_id, c.to_component_id]),
    ...settings.map((s) => s.component_id),
    ...jacks.flatMap((j) => [j.a_component_id, j.b_component_id]),
  ].filter((id) => id != null);
  const components = componentIds.length
    ? await ModuleComponent.findAll({
        where: { id: [...new Set(componentIds)] },
        attributes: ['id', 'type'],
      })
    : [];
  const componentType = new Map(components.map((c) => [c.id, c.type]));

  // Instances are numbered from 1 in the order they appear; everything that
  // refers to an instance refers to that number.
  const refs = new Map(modules.map((m, at) => [m.id, at + 1]));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  return {
    format: PATCH_FORMAT,
    version: PATCH_FORMAT_VERSION,
    patch: {
      name: patch.name,
      description: patch.description ?? null,
      // The rack the patch was built against, by name — an id would be
      // meaningless in another account. A patch built from a whole system
      // names the system instead, and each instance names its own rack.
      rack_name: patch.rack_name,
      system_name: patch.system_name ?? null,
      groups: groups.map((g) => ({
        name: g.name,
        description: g.description ?? null,
        position: g.position,
      })),
      modules: modules.map((m) => ({
        ref: refs.get(m.id),
        manufacturer: m.manufacturer,
        module_name: m.module_name,
        instance: m.instance,
        rack_name: m.rack_name ?? null,
        label: m.label ?? null,
        group: m.group_id === null ? null : (groupNames.get(m.group_id) ?? null),
        external: Boolean(m.external),
        ports: ports
          .filter((p) => p.patch_module_id === m.id)
          .map((p) => ({
            name: p.name,
            type: p.type,
            port_kind: p.port_kind ?? null,
            description: p.description ?? null,
            position: p.position,
          })),
      })),
      cables: cables.map((c) => ({
        from: {
          module: refs.get(c.from_patch_module_id) ?? null,
          jack: c.from_component_name,
          type: componentType.get(c.from_component_id) ?? null,
        },
        to: {
          module: refs.get(c.to_patch_module_id) ?? null,
          jack: c.to_component_name,
          type: componentType.get(c.to_component_id) ?? null,
        },
        note: c.note ?? null,
        optional: Boolean(c.optional),
        stacked: Boolean(c.stacked),
        alt_group: c.alt_group ?? null,
      })),
      settings: settings.map((s) => ({
        module: refs.get(s.patch_module_id) ?? null,
        control: s.component_name,
        type: componentType.get(s.component_id) ?? null,
        // The MENU parameter this value belongs to, by name, for the
        // menu-driven modules whose settings hang off a jack (or off nothing
        // at all) rather than off a control with a position.
        parameter: s.parameter_name ?? null,
        value: s.value,
      })),
      links: links.map((l) => ({
        a: refs.get(l.a_patch_module_id) ?? null,
        b: refs.get(l.b_patch_module_id) ?? null,
        kind: l.kind,
        description: l.description ?? null,
        jacks: jacks
          .filter((j) => j.link_id === l.id)
          .map((j) => ({
            a: j.a_component_name,
            a_type: componentType.get(j.a_component_id) ?? null,
            b: j.b_component_name,
            b_type: componentType.get(j.b_component_id) ?? null,
          })),
      })),
    },
  };
}

// What the browser should call the downloaded file.
export function patchFileName(patch) {
  const stem = String(patch.name || 'patch')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${stem || 'patch'}.patch.json`;
}
