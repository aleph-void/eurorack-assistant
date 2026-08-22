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
import { loadPatchRackLayout } from './patchLayout.js';
import { parametersByModule as loadParametersByModule } from './moduleParameters.js';

export const patchJson = (patch, extra = {}) => ({
  id: patch.id,
  name: patch.name,
  description: patch.description,
  rack_id: patch.rack_id,
  rack_name: patch.rack_name,
  // Set instead of rack_id when the patch spans a whole system.
  system_id: patch.system_id ?? null,
  system_name: patch.system_name ?? null,
  created_at: patch.created_at,
  updated_at: patch.updated_at,
  ...extra,
});

// `describe` is off for the payload the browser draws a patch from: what each
// control DOES is prose the patch page never shows, and on a patch of a whole
// studio it is a megabyte of it. The LLM-facing readers (services/ask.js) and
// the scope keep the default.
export const componentJson = (c, { describe = true } = {}) => ({
  id: c.id,
  type: c.type,
  name: c.name,
  ...(describe ? { description: c.description } : {}),
  voltage_min: c.voltage_min ?? null,
  voltage_max: c.voltage_max ?? null,
  polarity: c.polarity ?? null,
  group_label: c.group_label ?? null,
  port_kind: c.port_kind ?? null,
});

// A connection point declared inside the patch (external gear, or a module
// the rack does not hold) presented in the same shape as a component, so
// cables, settings and the tracers need no special case.
export const portJson = (p, { describe = true } = {}) => ({
  id: p.id,
  type: p.type,
  name: p.name,
  ...(describe ? { description: p.description } : {}),
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

export const moduleJson = (pm, { live, components, panel = null, hp = null, parameters = [] }) => ({
  id: pm.id,
  module_id: pm.module_id,
  manufacturer: pm.manufacturer,
  module_name: pm.module_name,
  instance: pm.instance,
  // Which rack of the system this copy was snapshotted from. Null on
  // patches made before systems existed, and on gear added by hand.
  rack_id: pm.rack_id ?? null,
  rack_name: pm.rack_name ?? null,
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
  hp,
  // The module's MENU — the settings it holds behind an encoder rather than
  // under a control, each hanging off the jack it configures. Empty for all
  // but the menu-driven modules.
  parameters,
});

// Everything the patch is made of, resolved: the snapshot instances with
// their jacks, the cables and settings, and the graph the tracers walk.
//
// `includeRackLayout` is false when the patch is served to someone it was
// shared with: the rack's physical row/HP geometry belongs to the rack, which
// is a separately-shareable record, and must not leak just because a patch
// that happens to sit in it was shared.
export async function loadPatchDetail(db, patch, { includeRackLayout = true, describe = true } = {}) {
const {
  Module,
  ModuleComponent,
  ComponentValue,
  ComponentNormalization,
  ComponentRoute,
  ComponentSwitch,
  ComponentSwitchStep,
  ComponentMultGroup,
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
      ...componentJson(c, { describe }),
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
    portsByPatchModule.get(p.patch_module_id).push({ ...portJson(p, { describe }), values: [] });
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

  // A switched multiple's per-jack bus toggles: which section each jack joins
  // in each position of its control. Resolved against the patch's recorded
  // settings in buildPatchTopology.
  const multGroupsByModule = groupByModule(await load(ComponentMultGroup));

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
    multGroupsByModule,
    pairsByModule,
    links,
    settings: settings.map((s) => s.get({ plain: true })),
    cables: cables.map((c) => c.get({ plain: true })),
  });

  const panels = await loadPanels(db, [...liveIds], { describe });
  // The menu parameters of every module still in the rack, so the patch pages
  // can offer them to dial in. Prose travels with `describe`, exactly as a
  // component's description does: a studio's worth of option descriptions is
  // a megabyte none of the patch pages shows.
  const parametersByModule = await loadParametersByModule(db, [...liveIds], { describe });
  // The physical arrangement is the patch's OWN copy of the racks it was
  // built from (services/patchLayout.js), not the racks as they stand today
  // — reorganising a case does not rearrange the patches already made from
  // it. A patch catches up only when its owner asks it to.
  const { rows: layoutRows, placements: rowPlacements } = includeRackLayout
    ? await loadPatchRackLayout(db, patch.id)
    : { rows: [], placements: [] };
  // A placement names a module model, while a patch snapshots physical
  // instances. Assign each placed copy to the next matching snapshot instance
  // OF THE SAME RACK, so the two Mathses of a two-rack system do not swap
  // ends of the studio.
  const instanceKey = (rackId, moduleId) => `${rackId ?? patch.rack_id ?? 0}:${moduleId}`;
  const instancesByModule = new Map();
  for (const pm of patchModules) {
    const key = instanceKey(pm.rack_id, pm.module_id);
    if (!instancesByModule.has(key)) instancesByModule.set(key, []);
    instancesByModule.get(key).push(pm.id);
  }
  const usedInstances = new Set();
  // Rows in the order the studio reads, each carrying the rack it belongs to
  // so a multi-rack diagram can say which case a row is in.
  const rack_layout = layoutRows.map((row) => ({
    id: row.id,
    rack_id: row.rack_id,
    rack_name: row.rack_name,
    // Where this row stands in the studio: its rack's own place on the
    // system's floor plan (x in HP, y in rack units) plus the row's place
    // inside that rack. A single-rack patch has one rack at the origin, so
    // this is 0/0 and the rows simply stack.
    rack_x: row.rack_x ?? 0,
    rack_y: row.rack_y ?? 0,
    position: row.position,
    unit: row.unit,
    hp: row.hp,
    modules: rowPlacements
      .filter((placement) => placement.row_id === row.id)
      .map((placement) => {
        const instance = (
          instancesByModule.get(instanceKey(row.rack_id, placement.module_id)) ?? []
        ).find((id) => !usedInstances.has(id));
        if (instance) usedInstances.add(instance);
        return instance ?? null;
      })
      .filter(Boolean),
  }));

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
          hp: liveModules.find((module) => module.id === pm.module_id)?.hp ?? null,
          // The module's menu — what can be dialed in on it that has no
          // control of its own. Empty for all but the menu-driven modules.
          parameters: parametersByModule.get(pm.module_id) ?? [],
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
        // The menu parameter this value belongs to, when it is one: a jack
        // carries as many of these as its menu has entries, where a control
        // carries exactly one value.
        parameter_id: s.parameter_id,
        parameter_name: s.parameter_name,
        value: s.value,
      })),
      // Jacks that carry the two halves of one signal, per instance, so the
      // GUI can offer "patch the stereo pair" as one action.
      pairs: topology.pairs,
      // The routing switch sections of this patch — the common jack and the
      // steps it selects between, resolved onto instances. A switch SELECTS
      // one of its connections where a mult COPIES to all of them, so the
      // picture cannot tell which way a bidirectional switch jack runs
      // without knowing the section it belongs to.
      switches: topology.switches,
      // The mult sections of this patch: which bidirectional jacks are copies
      // of each other, with a switched multiple's memberships already decided
      // by the control positions the patch records. The picture and the cable
      // rules read these rather than grouping by label themselves, so a jack
      // whose bus toggle is unrecorded is a possibility everywhere at once
      // rather than a copy nobody asked for.
      mults: topology.mults,
      // Normalled connections, resolved against THIS patch: each one is
      // active until the cable that cancels it is patched, and its signal
      // is traced through the chain to where it really comes from.
      normalizations: resolveNormalledSignals(topology),
      // Whole-patch signal flow: internal routes carry signal across each
      // module, so a generator output can be followed through cables,
      // mults, normals, switches, expanders and bridges to everywhere it
      // ends up.
      flow: buildSignalFlow(topology),
      rack_layout,
    },
  };
}
