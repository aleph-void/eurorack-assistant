// Reading one patch back out of the database: the snapshot instances with
// their jacks, the cables and settings, and the resolved graph the tracers
// walk. Lives outside routes/patches.js because the oscilloscope routes need
// the same picture of a patch to work out what each scope channel is looking
// at, and there must be exactly one answer to "what is in this patch".

import { Op } from 'sequelize';
import { buildPatchTopology } from './patchTopology.js';
import { resolveNormalledSignals } from './patchSignals.js';
import { buildSignalFlow } from './patchFlow.js';
import { loadPanels } from './panelImage.js';

export const patchJson = (patch, extra = {}) => ({
  id: patch.id,
  name: patch.name,
  description: patch.description,
  rack_id: patch.rack_id,
  rack_name: patch.rack_name,
  created_at: patch.created_at,
  updated_at: patch.updated_at,
  ...extra,
});

export const componentJson = (c) => ({
  id: c.id,
  type: c.type,
  name: c.name,
  description: c.description,
  voltage_min: c.voltage_min ?? null,
  voltage_max: c.voltage_max ?? null,
  polarity: c.polarity ?? null,
  group_label: c.group_label ?? null,
  port_kind: c.port_kind ?? null,
});

// A connection point declared inside the patch (external gear, or a module
// the rack does not hold) presented in the same shape as a component, so
// cables, settings and the tracers need no special case.
export const portJson = (p) => ({
  id: p.id,
  type: p.type,
  name: p.name,
  description: p.description,
  voltage_min: null,
  voltage_max: null,
  polarity: null,
  group_label: null,
  port_kind: p.port_kind ?? null,
  declared: true,
});

export const cableJson = (c) => ({
  id: c.id,
  from_patch_module_id: c.from_patch_module_id,
  from_component_id: c.from_component_id,
  from_component_name: c.from_component_name,
  to_patch_module_id: c.to_patch_module_id,
  to_component_id: c.to_component_id,
  to_component_name: c.to_component_name,
  note: c.note ?? null,
  optional: Boolean(c.optional),
  stacked: Boolean(c.stacked),
  alt_group: c.alt_group ?? null,
});

export const moduleJson = (pm, { live, components, panel = null }) => ({
  id: pm.id,
  module_id: pm.module_id,
  manufacturer: pm.manufacturer,
  module_name: pm.module_name,
  instance: pm.instance,
  label: pm.label ?? null,
  group_id: pm.group_id ?? null,
  external: Boolean(pm.external),
  // false when the module record has since been deleted (or was never in
  // the rack) — the snapshot row still renders, and its connection points
  // are whatever the patch declares on it.
  live,
  components,
  // The module's front plate and where its jacks sit on it, so the patch can
  // be drawn as panels and cables. null for gear with no analyzed panel; the
  // diagram falls back to a plain outline for those.
  panel,
});

// Everything the patch is made of, resolved: the snapshot instances with
// their jacks, the cables and settings, and the graph the tracers walk.
export async function loadPatchDetail(db, patch) {
const {
  Module,
  ModuleComponent,
  ComponentValue,
  ComponentNormalization,
  ComponentRoute,
  ComponentSwitch,
  ComponentSwitchStep,
  ComponentPair,
  ModuleExpander,
  PatchModule,
  PatchCable,
  PatchSetting,
  PatchGroup,
  PatchModulePort,
  PatchModuleLink,
  PatchModuleLinkJack,
} = db.models;

  const patchModules = await PatchModule.findAll({
    where: { patch_id: patch.id },
    order: [['id', 'ASC']],
  });
  const moduleIds = [...new Set(patchModules.map((pm) => pm.module_id).filter(Boolean))];
  const liveModules = moduleIds.length === 0 ? [] : await Module.findAll({ where: { id: moduleIds } });
  const liveIds = new Set(liveModules.map((m) => m.id));

  // An expander's jacks belong to its own module record, which may not be
  // in this patch — but a route declared on the host can still reach them,
  // so the components of every linked panel are loaded too.
  const expanderRows =
    liveIds.size === 0
      ? []
      : await ModuleExpander.findAll({
          where: {
            [Op.or]: [{ host_module_id: [...liveIds] }, { expander_module_id: [...liveIds] }],
          },
        });
  const relatedIds = new Set(liveIds);
  for (const e of expanderRows) {
    relatedIds.add(e.host_module_id);
    relatedIds.add(e.expander_module_id);
  }

  const components =
    relatedIds.size === 0
      ? []
      : await ModuleComponent.findAll({
          where: { module_id: [...relatedIds] },
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
      ...componentJson(c),
      values: valuesByComponent.get(c.id) ?? [],
    });
  }

  const portRows = await PatchModulePort.findAll({
    where: { patch_module_id: patchModules.map((pm) => pm.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const portsByPatchModule = new Map();
  for (const p of portRows) {
    if (!portsByPatchModule.has(p.patch_module_id)) portsByPatchModule.set(p.patch_module_id, []);
    portsByPatchModule.get(p.patch_module_id).push({ ...portJson(p), values: [] });
  }

  const cables = await PatchCable.findAll({
    where: { patch_id: patch.id },
    order: [['id', 'ASC']],
  });
  const settings = await PatchSetting.findAll({
    where: { patch_id: patch.id },
    order: [['id', 'ASC']],
  });
  const groups = await PatchGroup.findAll({
    where: { patch_id: patch.id },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  const linkRows = await PatchModuleLink.findAll({
    where: { patch_id: patch.id },
    order: [['id', 'ASC']],
  });
  const linkJackRows =
    linkRows.length === 0
      ? []
      : await PatchModuleLinkJack.findAll({
          where: { link_id: linkRows.map((l) => l.id) },
          order: [['id', 'ASC']],
        });
  const links = linkRows.map((l) => ({
    id: l.id,
    kind: l.kind,
    a_patch_module_id: l.a_patch_module_id,
    b_patch_module_id: l.b_patch_module_id,
    description: l.description,
    jacks: linkJackRows
      .filter((j) => j.link_id === l.id)
      .map((j) => ({
        id: j.id,
        a_component_id: j.a_component_id,
        a_component_name: j.a_component_name,
        b_component_id: j.b_component_id,
        b_component_name: j.b_component_name,
      })),
  }));

  const load = async (model, extra = {}) =>
    relatedIds.size === 0
      ? []
      : model.findAll({ where: { module_id: [...relatedIds] }, order: [['id', 'ASC']], ...extra });
  const groupByModule = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.module_id)) map.set(r.module_id, []);
      map.get(r.module_id).push(r.get ? r.get({ plain: true }) : r);
    }
    return map;
  };
  const normalizationsByModule = groupByModule(await load(ComponentNormalization));
  const routesByModule = groupByModule(await load(ComponentRoute));
  const pairsByModule = groupByModule(await load(ComponentPair));

  const switchRows = await load(ComponentSwitch);
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

  const plainPatchModules = patchModules.map((pm) => ({
    id: pm.id,
    module_id: pm.module_id !== null && liveIds.has(pm.module_id) ? pm.module_id : null,
    external: Boolean(pm.external),
  }));
  const topology = buildPatchTopology({
    patchModules: plainPatchModules,
    componentsByModule,
    portsByPatchModule,
    routesByModule,
    normalizationsByModule,
    switchesByModule,
    pairsByModule,
    links,
    settings: settings.map((s) => s.get({ plain: true })),
    cables: cables.map((c) => c.get({ plain: true })),
  });

  const panels = await loadPanels(db, [...liveIds]);

  return {
    patchModules,
    liveIds,
    topology,
    json: {
      modules: patchModules.map((pm) =>
        moduleJson(pm, {
          live: pm.module_id !== null && liveIds.has(pm.module_id),
          components: topology.jacksByPatchModule.get(pm.id) ?? [],
          panel: panels.get(pm.module_id) ?? null,
        })
      ),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        position: g.position,
      })),
      links,
      cables: cables.map(cableJson),
      settings: settings.map((s) => ({
        id: s.id,
        patch_module_id: s.patch_module_id,
        component_id: s.component_id,
        component_name: s.component_name,
        value: s.value,
      })),
      // Jacks that carry the two halves of one signal, per instance, so the
      // GUI can offer "patch the stereo pair" as one action.
      pairs: topology.pairs,
      // Normalled connections, resolved against THIS patch: each one is
      // active until the cable that cancels it is patched, and its signal
      // is traced through the chain to where it really comes from.
      normalizations: resolveNormalledSignals(topology),
      // Whole-patch signal flow: internal routes carry signal across each
      // module, so a generator output can be followed through cables,
      // mults, normals, switches, expanders and bridges to everywhere it
      // ends up.
      flow: buildSignalFlow(topology),
    },
  };
}
