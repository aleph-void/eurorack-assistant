// One patch, resolved into a flat graph the tracers can walk.
//
// Everything a module declares — internal routes, normalled connections,
// routing switch sections, stereo pairs — is stored against the MODULE, while
// a patch is made of module INSTANCES. Two further wrinkles make that mapping
// non-trivial:
//
//   - an expander's jacks belong to a different module record than the host
//     whose routes reach them (Atlantix + Atlx), so an edge can cross from
//     one instance to another without a patch cable;
//   - an instance may have no analyzed module behind it at all — off-rack
//     gear, or a module the rack does not hold — and carries its own
//     connection points instead.
//
// So this resolver turns module-scoped rows into edges whose ends are
// (instance, jack) pairs, decides which conditional paths are live from the
// control settings the patch records, and hands the tracers a structure with
// no database shapes and no module/instance ambiguity left in it.

// A conditional path whose control has no recorded setting, and any path that
// belongs to a set of alternatives, is EXCLUSIVE: it is one of several
// possibilities rather than something happening simultaneously with the
// others. The tracers use this to tell selecting a signal from mixing signals.
function isExclusive(condition, altGroup) {
  if (condition?.state === 'unset') return true;
  return Boolean(altGroup) && condition?.state !== 'selected';
}

export function buildPatchTopology({
  patchModules = [],
  componentsByModule = new Map(),
  portsByPatchModule = new Map(),
  routesByModule = new Map(),
  normalizationsByModule = new Map(),
  switchesByModule = new Map(),
  pairsByModule = new Map(),
  links = [],
  settings = [],
  cables = [],
} = {}) {
  // The jacks and controls of each instance: an analyzed module's components,
  // or the connection points declared on the instance itself.
  const jacksByPatchModule = new Map();
  for (const pm of patchModules) {
    const own = pm.module_id ? componentsByModule.get(pm.module_id) : null;
    jacksByPatchModule.set(pm.id, own ?? portsByPatchModule.get(pm.id) ?? []);
  }
  const pmById = new Map(patchModules.map((pm) => [pm.id, pm]));
  const componentAt = (pmId, componentId) =>
    (jacksByPatchModule.get(pmId) || []).find((c) => c.id === componentId) || null;

  // Instances wired together without patch cables. An 'expander' link makes
  // two instances one instrument, so a route declared on either module may
  // end on the other's panel; a 'bridge' carries named signals between two
  // instances (Omnitone 7Path's ethernet pair).
  const expanderPartners = new Map();
  for (const link of links) {
    if (link.kind !== 'expander') continue;
    for (const [a, b] of [
      [link.a_patch_module_id, link.b_patch_module_id],
      [link.b_patch_module_id, link.a_patch_module_id],
    ]) {
      if (!pmById.has(a) || !pmById.has(b)) continue;
      if (!expanderPartners.has(a)) expanderPartners.set(a, []);
      expanderPartners.get(a).push(b);
    }
  }

  // Which instance a component id belongs to, seen from one instance: itself
  // when it owns the component, otherwise a linked expander panel.
  const ownerOf = (pmId, componentId) => {
    if (componentId === null || componentId === undefined) return null;
    if (componentAt(pmId, componentId)) return pmId;
    for (const partnerId of expanderPartners.get(pmId) || []) {
      if (pmById.get(partnerId)?.module_id && componentAt(partnerId, componentId)) return partnerId;
    }
    return null;
  };

  const settingOf = new Map();
  for (const s of settings) settingOf.set(`${s.patch_module_id}:${s.component_id}`, s.value);
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

  // Whether a path that depends on a control position is live in this patch.
  //   'unconditional' — the path always exists
  //   'selected'      — the patch records that control at the required value
  //   'unselected'    — the patch records it at a different value
  //   'unset'         — the patch does not say, so the path is one possibility
  const conditionOf = (pmId, row) => {
    if (!row.condition_component_id) return null;
    const ownerId = ownerOf(pmId, row.condition_component_id);
    const control = ownerId === null ? null : componentAt(ownerId, row.condition_component_id);
    if (!control) return null;
    const recorded = settingOf.get(`${ownerId}:${control.id}`);
    const state =
      recorded === undefined ? 'unset' : same(recorded, row.condition_value) ? 'selected' : 'unselected';
    return {
      patch_module_id: ownerId,
      component_id: control.id,
      component_name: control.name,
      value: row.condition_value,
      state,
      setting: recorded ?? null,
    };
  };

  const routes = [];
  const normalizations = [];
  const switches = [];
  const pairs = [];
  for (const pm of patchModules) {
    if (!pm.module_id) continue;

    for (const r of routesByModule.get(pm.module_id) || []) {
      const fromPm = ownerOf(pm.id, r.input_component_id);
      const toPm = ownerOf(pm.id, r.output_component_id);
      if (fromPm === null || toPm === null) continue;
      const condition = conditionOf(pm.id, r);
      // A path the patch positively rules out is not part of this patch.
      if (condition?.state === 'unselected') continue;
      routes.push({
        id: r.id,
        patch_module_id: pm.id,
        from_patch_module_id: fromPm,
        from_component_id: r.input_component_id,
        to_patch_module_id: toPm,
        to_component_id: r.output_component_id,
        condition,
        alt_group: r.alt_group ?? null,
        exclusive: isExclusive(condition, r.alt_group),
        description: r.description ?? null,
      });
    }

    for (const n of normalizationsByModule.get(pm.module_id) || []) {
      const targetPm = ownerOf(pm.id, n.target_component_id);
      if (targetPm === null) continue;
      const sourcePm = n.source_component_id ? ownerOf(pm.id, n.source_component_id) : null;
      if (n.source_component_id && sourcePm === null) continue;
      const condition = conditionOf(pm.id, n);
      if (condition?.state === 'unselected') continue;
      // What cancels this default: by default a cable arriving at the target,
      // but an output normalled to another output is cancelled by a cable
      // LEAVING the jack named in break_component_id.
      const breakPm = n.break_component_id ? ownerOf(pm.id, n.break_component_id) : null;
      const hasOwnBreak = Boolean(n.break_component_id) && breakPm !== null;
      normalizations.push({
        id: n.id,
        patch_module_id: pm.id,
        target_patch_module_id: targetPm,
        target_component_id: n.target_component_id,
        source_patch_module_id: sourcePm,
        source_component_id: n.source_component_id ?? null,
        source_label: n.source_label ?? null,
        kind: n.kind,
        break_patch_module_id: hasOwnBreak ? breakPm : targetPm,
        break_component_id: hasOwnBreak ? n.break_component_id : n.target_component_id,
        break_on: hasOwnBreak ? n.break_on || 'cable_in' : 'cable_in',
        condition,
        alt_group: n.alt_group ?? null,
        exclusive: isExclusive(condition, n.alt_group),
        description: n.description ?? null,
      });
    }

    for (const s of switchesByModule.get(pm.module_id) || []) {
      const commonPm = ownerOf(pm.id, s.common_component_id);
      if (commonPm === null) continue;
      const steps = (s.step_component_ids || [])
        .map((componentId) => ({ patch_module_id: ownerOf(pm.id, componentId), component_id: componentId }))
        .filter((step) => step.patch_module_id !== null);
      if (steps.length === 0) continue;
      switches.push({
        id: s.id,
        patch_module_id: pm.id,
        name: s.name ?? null,
        common_patch_module_id: commonPm,
        common_component_id: s.common_component_id,
        steps,
      });
    }

    for (const p of pairsByModule.get(pm.module_id) || []) {
      if (!componentAt(pm.id, p.a_component_id) || !componentAt(pm.id, p.b_component_id)) continue;
      pairs.push({
        id: p.id,
        patch_module_id: pm.id,
        a_component_id: p.a_component_id,
        b_component_id: p.b_component_id,
        kind: p.kind,
        description: p.description ?? null,
      });
    }
  }

  // Bridges: jack N of one instance carries the same signal as jack N of the
  // other, in whichever direction the patch cables them. Jack rows keep names
  // as well as ids so a bridge survives a re-analysis renumbering components.
  const bridges = [];
  for (const link of links) {
    if (link.kind !== 'bridge') continue;
    const a = pmById.get(link.a_patch_module_id);
    const b = pmById.get(link.b_patch_module_id);
    if (!a || !b) continue;
    const resolve = (pmId, componentId, name) => {
      const byId = componentId === null || componentId === undefined ? null : componentAt(pmId, componentId);
      if (byId) return byId;
      return (
        (jacksByPatchModule.get(pmId) || []).find(
          (c) => c.type.endsWith('_jack') && same(c.name, name)
        ) || null
      );
    };
    for (const jack of link.jacks || []) {
      const aJack = resolve(a.id, jack.a_component_id, jack.a_component_name);
      const bJack = resolve(b.id, jack.b_component_id, jack.b_component_name);
      if (!aJack || !bJack) continue;
      bridges.push({
        link_id: link.id,
        a_patch_module_id: a.id,
        a_component_id: aJack.id,
        a_component_name: aJack.name,
        b_patch_module_id: b.id,
        b_component_id: bJack.id,
        b_component_name: bJack.name,
      });
    }
  }

  // Which cable, if any, cancels each normalled connection — computed once
  // here so every consumer agrees on what is active.
  const cableInto = new Map();
  const cableOutOf = new Map();
  for (const c of cables) {
    cableInto.set(`${c.to_patch_module_id}:${c.to_component_id}`, c);
    const from = `${c.from_patch_module_id}:${c.from_component_id}`;
    if (!cableOutOf.has(from)) cableOutOf.set(from, c);
  }
  for (const n of normalizations) {
    const key = `${n.break_patch_module_id}:${n.break_component_id}`;
    const cable = (n.break_on === 'cable_out' ? cableOutOf : cableInto).get(key) ?? null;
    n.broken_by_cable_id = cable ? cable.id : null;
  }

  return {
    patchModules,
    jacksByPatchModule,
    routes,
    normalizations,
    switches,
    bridges,
    pairs,
    links,
    cables,
  };
}
