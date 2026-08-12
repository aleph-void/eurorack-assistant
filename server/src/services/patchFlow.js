// Whole-patch signal flow. Builds a directed graph over the patch's jacks
// (per module instance) and expands it into one tree per signal source, so
// the GUI can show where every signal originates and everywhere it goes.
//
// Edges:
//   cable  — a patch cable, output jack → input jack
//   route  — a module-internal signal path (component_routes): the input's
//            signal appears at the output (mixer channel → mix out, filter
//            in → LP/BP/HP). This is what carries flow ACROSS a module.
//   normal — an ACTIVE normalled connection (nothing patched into its target)
//   mult   — a mult-group copy: the jack a cable lands in feeds the group's
//            other jacks that send cables onward
//   switch — a routing switch section: the common jack and its step jacks,
//            connected ONE AT A TIME. Direction follows the cabling: a cable
//            into the common makes the cabled steps its (selectable)
//            destinations; cables into steps make the common their shared
//            destination.
//
// Sources (tree roots) are nodes that emit signal but receive none: output
// jacks no route feeds (= signal generators — oscillators, noise, LFOs) and
// internal normalled sources. Splits appear as multiple children (stacked
// cables, mult copies, one input routed to several outputs); merges are
// nodes with more than one incoming edge, flagged `merge` (mixer outputs);
// feedback loops are cut with a `cycle` flag instead of recursing forever.
//
// A switch's branches are alternatives, not simultaneous: children reached
// by a 'switch' edge carry `switched: true`, and a node whose incoming edges
// are all 'switch' edges is flagged `switched_merge` instead of `merge` — it
// receives one of those signals at a time, it does not mix them.

export const MAX_FLOW_NODES = 200;

export function buildSignalFlow({
  patchModules,
  componentsByModule,
  routesByModule,
  normalizationsByModule,
  switchesByModule = new Map(),
  cables,
}) {
  const nodes = new Map();
  const edges = [];
  const pmById = new Map(patchModules.map((pm) => [pm.id, pm]));
  const jackKey = (pmId, componentId) => `pm${pmId}:c${componentId}`;

  const addJackNode = (pmId, componentId, fallbackName) => {
    const key = jackKey(pmId, componentId);
    if (nodes.has(key)) return key;
    const pm = pmById.get(pmId);
    const component = pm?.module_id
      ? (componentsByModule.get(pm.module_id) || []).find((c) => c.id === componentId)
      : null;
    nodes.set(key, {
      key,
      kind: 'jack',
      patch_module_id: pmId,
      component_id: componentId,
      name: component?.name ?? fallbackName ?? `#${componentId}`,
      jack_type: component?.type ?? null,
    });
    return key;
  };
  const addInternalNode = (pmId, label) => {
    const key = `pm${pmId}:internal:${label.toLowerCase()}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        kind: 'internal',
        patch_module_id: pmId,
        component_id: null,
        name: label,
        jack_type: null,
      });
    }
    return key;
  };

  // Cables first — they also decide which normals are active and which mult
  // jack is its group's input.
  const cabledInto = new Set();
  for (const c of cables) {
    const from = addJackNode(c.from_patch_module_id, c.from_component_id, c.from_component_name);
    const to = addJackNode(c.to_patch_module_id, c.to_component_id, c.to_component_name);
    edges.push({ from, to, kind: 'cable' });
    cabledInto.add(to);
  }

  for (const pm of patchModules) {
    if (!pm.module_id) continue;
    const components = componentsByModule.get(pm.module_id) || [];

    for (const r of routesByModule.get(pm.module_id) || []) {
      edges.push({
        from: addJackNode(pm.id, r.input_component_id),
        to: addJackNode(pm.id, r.output_component_id),
        kind: 'route',
      });
    }

    for (const n of normalizationsByModule.get(pm.module_id) || []) {
      const target = jackKey(pm.id, n.target_component_id);
      if (cabledInto.has(target)) continue; // broken by the cable
      const from = n.source_component_id
        ? addJackNode(pm.id, n.source_component_id)
        : addInternalNode(pm.id, n.source_label || 'internal signal');
      edges.push({ from, to: addJackNode(pm.id, n.target_component_id), kind: 'normal' });
    }

    // Routing switches: which way the section runs is decided by the cables.
    // A cable into the common → the common feeds every step that cables
    // onward (1-to-many distribution, one step live at a time). Cables into
    // steps → those steps feed the common (many-to-one selection).
    const switchJackIds = new Set();
    for (const section of switchesByModule.get(pm.module_id) || []) {
      const commonKey = jackKey(pm.id, section.common_component_id);
      switchJackIds.add(section.common_component_id);
      for (const id of section.step_component_ids) switchJackIds.add(id);
      const commonFed = cabledInto.has(commonKey);
      for (const stepId of section.step_component_ids) {
        const stepKey = jackKey(pm.id, stepId);
        const stepFed = cabledInto.has(stepKey);
        if (commonFed && !stepFed) {
          // The step only matters as a destination if it cables onward.
          if (edges.some((e) => e.kind === 'cable' && e.from === stepKey)) {
            edges.push({
              from: addJackNode(pm.id, section.common_component_id),
              to: addJackNode(pm.id, stepId),
              kind: 'switch',
            });
          }
        } else if (stepFed && !commonFed) {
          edges.push({
            from: addJackNode(pm.id, stepId),
            to: addJackNode(pm.id, section.common_component_id),
            kind: 'switch',
          });
        }
      }
    }

    // Mult copies: the group jack a cable lands in feeds every sibling that
    // sends a cable onward. Switch-section jacks are excluded — a switch
    // selects one connection, it does not copy to all of them.
    const groups = new Map();
    for (const j of components.filter(
      (c) => c.type === 'bidirectional_jack' && !switchJackIds.has(c.id)
    )) {
      const key = (j.group_label || '').trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(j);
    }
    for (const jacks of groups.values()) {
      const input = jacks.find((j) => cabledInto.has(jackKey(pm.id, j.id)));
      if (!input) continue;
      for (const j of jacks) {
        if (j.id === input.id) continue;
        const from = jackKey(pm.id, j.id);
        if (edges.some((e) => e.kind === 'cable' && e.from === from)) {
          edges.push({ from: jackKey(pm.id, input.id), to: from, kind: 'mult' });
        }
      }
    }
  }

  const out = new Map();
  const inDegree = new Map();
  const switchOnlyIn = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    // A convergence fed only through switch edges is a selection, not a mix.
    switchOnlyIn.set(e.to, (switchOnlyIn.get(e.to) ?? true) && e.kind === 'switch');
  }

  // A source emits signal without receiving any: internal normalled signals,
  // and non-input jacks with no incoming edge (an output jack here is a
  // generator — no internal route feeds it).
  const sources = [...nodes.values()]
    .filter(
      (n) =>
        !inDegree.has(n.key) &&
        out.has(n.key) &&
        (n.kind === 'internal' || n.jack_type !== 'input_jack')
    )
    .sort((a, b) => a.patch_module_id - b.patch_module_id || a.key.localeCompare(b.key));

  // One tree per source. A node already on the path to itself is a feedback
  // loop and stops the walk; a per-tree node budget bounds diamond blow-ups.
  const expand = (key, via, path, budget) => {
    const node = nodes.get(key);
    const converges = (inDegree.get(key) ?? 0) > 1;
    const selected = converges && switchOnlyIn.get(key) === true;
    const row = {
      ...node,
      via, // edge kind that reached this node; null on roots
      // Reached through a switch: this branch is one of several alternatives.
      switched: via === 'switch',
      // A real mix (several signals summing) vs a switch picking one of them.
      merge: converges && !selected,
      switched_merge: selected,
      cycle: path.has(key),
      children: [],
    };
    budget.count += 1;
    if (row.cycle || budget.count >= MAX_FLOW_NODES) return row;
    const next = new Set(path);
    next.add(key);
    for (const e of out.get(key) || []) {
      row.children.push(expand(e.to, e.kind, next, budget));
    }
    return row;
  };
  return sources.map((s) => expand(s.key, null, new Set(), { count: 0 }));
}
