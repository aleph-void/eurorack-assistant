// Whole-patch signal flow. Builds a directed graph over the patch's jacks
// (per module instance) and expands it into one tree per signal source, so
// the GUI can show where every signal originates and everywhere it goes.
//
// Edges:
//   cable  — a patch cable, output jack → input jack
//   route  — a module-internal signal path (component_routes): the input's
//            signal appears at the output (mixer channel → mix out, filter
//            in → LP/BP/HP). This is what carries flow ACROSS a module, and
//            it may end on an expander's panel (Atlantix → Atlx).
//   normal — an ACTIVE normalled connection (nothing overriding it)
//   mult   — a mult-group copy: the jack a cable lands in feeds the group's
//            other jacks that send cables onward
//   switch — a routing switch section: the common jack and its step jacks,
//            connected ONE AT A TIME. Direction follows the cabling: a cable
//            into the common makes the cabled steps its (selectable)
//            destinations; cables into steps make the common their shared
//            destination.
//   bridge — a non-patch link between two instances that carries a signal
//            between them (Omnitone 7Path's ethernet pair): the side a cable
//            lands in feeds its partner jack on the other instance.
//
// Sources (tree roots) are nodes that emit signal but receive none: output
// jacks no route feeds (= signal generators — oscillators, noise, LFOs) and
// internal normalled sources. Splits appear as multiple children (stacked
// cables, mult copies, one input routed to several outputs); merges are
// nodes with more than one incoming edge, flagged `merge` (mixer outputs);
// feedback loops are cut with a `cycle` flag instead of recursing forever.
//
// Not every path is live at the same time. A switch's branches are
// alternatives, and so are paths that depend on a control the patch has not
// pinned down — a mix switch that turns an output into a channel mix, a
// source switch choosing which signal is normalled to an input. Both arrive
// here marked EXCLUSIVE: children reached that way carry `switched: true`
// (and `conditional`/`condition` when a control decides it), and a node whose
// incoming edges are all exclusive is flagged `switched_merge` instead of
// `merge` — it receives one of those signals at a time, it does not mix them.

export const MAX_FLOW_NODES = 200;

export function buildSignalFlow(topology) {
  const {
    patchModules = [],
    jacksByPatchModule = new Map(),
    routes = [],
    normalizations = [],
    switches = [],
    bridges = [],
    cables = [],
  } = topology || {};

  const nodes = new Map();
  const edges = [];
  const jackKey = (pmId, componentId) => `pm${pmId}:c${componentId}`;
  const componentAt = (pmId, componentId) =>
    (jacksByPatchModule.get(pmId) || []).find((c) => c.id === componentId) || null;

  const addJackNode = (pmId, componentId, fallbackName) => {
    const key = jackKey(pmId, componentId);
    if (nodes.has(key)) return key;
    const component = componentAt(pmId, componentId);
    nodes.set(key, {
      key,
      kind: 'jack',
      patch_module_id: pmId,
      component_id: componentId,
      name: component?.name ?? fallbackName ?? `#${componentId}`,
      jack_type: component?.type ?? null,
      // 'midi_din', 'usb', ... on connections that leave the eurorack format.
      port_kind: component?.port_kind ?? null,
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
        port_kind: null,
      });
    }
    return key;
  };

  // Cables first — they also decide which normals are active, which mult jack
  // is its group's input, and which way a switch or bridge runs.
  const cabledInto = new Set();
  const cablesOutOf = new Set();
  for (const c of cables) {
    const from = addJackNode(c.from_patch_module_id, c.from_component_id, c.from_component_name);
    const to = addJackNode(c.to_patch_module_id, c.to_component_id, c.to_component_name);
    edges.push({ from, to, kind: 'cable', optional: Boolean(c.optional) });
    cabledInto.add(to);
    cablesOutOf.add(from);
  }

  for (const r of routes) {
    edges.push({
      from: addJackNode(r.from_patch_module_id, r.from_component_id),
      to: addJackNode(r.to_patch_module_id, r.to_component_id),
      kind: 'route',
      exclusive: r.exclusive,
      condition: r.condition,
    });
  }

  for (const n of normalizations) {
    if (n.broken_by_cable_id) continue; // overridden by a cable
    const from = n.source_component_id
      ? addJackNode(n.source_patch_module_id, n.source_component_id)
      : addInternalNode(n.patch_module_id, n.source_label || 'internal signal');
    edges.push({
      from,
      to: addJackNode(n.target_patch_module_id, n.target_component_id),
      kind: 'normal',
      exclusive: n.exclusive,
      condition: n.condition,
    });
  }

  // Routing switches: which way the section runs is decided by the cables.
  // A cable into the common → the common feeds every step that cables
  // onward (1-to-many distribution, one step live at a time). Cables into
  // steps → those steps feed the common (many-to-one selection).
  const switchJackKeys = new Set();
  for (const section of switches) {
    const commonKey = jackKey(section.common_patch_module_id, section.common_component_id);
    switchJackKeys.add(commonKey);
    for (const step of section.steps) switchJackKeys.add(jackKey(step.patch_module_id, step.component_id));
    const commonFed = cabledInto.has(commonKey);
    for (const step of section.steps) {
      const stepKey = jackKey(step.patch_module_id, step.component_id);
      const stepFed = cabledInto.has(stepKey);
      if (commonFed && !stepFed) {
        // The step only matters as a destination if it cables onward.
        if (cablesOutOf.has(stepKey)) {
          edges.push({
            from: addJackNode(section.common_patch_module_id, section.common_component_id),
            to: addJackNode(step.patch_module_id, step.component_id),
            kind: 'switch',
            exclusive: true,
          });
        }
      } else if (stepFed && !commonFed) {
        edges.push({
          from: addJackNode(step.patch_module_id, step.component_id),
          to: addJackNode(section.common_patch_module_id, section.common_component_id),
          kind: 'switch',
          exclusive: true,
        });
      }
    }
  }

  // Bridges: the bridged pair carries one signal between two instances, in
  // whichever direction it is cabled. Unlike a mult, the partner jack is the
  // whole point of the link, so the edge is drawn whether or not it cables
  // onward — that is how the patch shows the signal reaching the other case.
  for (const b of bridges) {
    const aKey = jackKey(b.a_patch_module_id, b.a_component_id);
    const bKey = jackKey(b.b_patch_module_id, b.b_component_id);
    const aFed = cabledInto.has(aKey);
    const bFed = cabledInto.has(bKey);
    if (aFed === bFed) continue; // both ends driven, or neither: nothing flows
    const [fromPm, fromId, toPm, toId] = aFed
      ? [b.a_patch_module_id, b.a_component_id, b.b_patch_module_id, b.b_component_id]
      : [b.b_patch_module_id, b.b_component_id, b.a_patch_module_id, b.a_component_id];
    edges.push({
      from: addJackNode(fromPm, fromId),
      to: addJackNode(toPm, toId),
      kind: 'bridge',
    });
  }

  // Mult copies: the group jack a cable lands in feeds every sibling that
  // sends a cable onward. Switch-section jacks are excluded — a switch
  // selects one connection, it does not copy to all of them — and so are
  // bridged jacks, which are paired one to one with the other panel rather
  // than being copies of each other.
  const bridgedKeys = new Set();
  for (const b of bridges) {
    bridgedKeys.add(jackKey(b.a_patch_module_id, b.a_component_id));
    bridgedKeys.add(jackKey(b.b_patch_module_id, b.b_component_id));
  }
  for (const pm of patchModules) {
    const groups = new Map();
    for (const j of (jacksByPatchModule.get(pm.id) || []).filter(
      (c) =>
        c.type === 'bidirectional_jack' &&
        !switchJackKeys.has(jackKey(pm.id, c.id)) &&
        !bridgedKeys.has(jackKey(pm.id, c.id))
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
        if (cablesOutOf.has(from)) {
          edges.push({ from: jackKey(pm.id, input.id), to: from, kind: 'mult' });
        }
      }
    }
  }

  const out = new Map();
  const inDegree = new Map();
  const exclusiveIn = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    // A convergence reached only by paths that are alternatives to each other
    // is a selection, not a mix.
    const exclusive = e.kind === 'switch' || Boolean(e.exclusive);
    exclusiveIn.set(e.to, (exclusiveIn.get(e.to) ?? true) && exclusive);
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
  // loop and stops the walk; a per-tree node budget bounds diamond blow-ups,
  // and says so rather than silently showing a partial tree.
  const expand = (key, edge, path, budget) => {
    const node = nodes.get(key);
    const converges = (inDegree.get(key) ?? 0) > 1;
    const selected = converges && exclusiveIn.get(key) === true;
    const exclusive = edge ? edge.kind === 'switch' || Boolean(edge.exclusive) : false;
    const row = {
      ...node,
      via: edge ? edge.kind : null, // edge kind that reached this node; null on roots
      // Reached by a path that is one of several alternatives.
      switched: exclusive,
      conditional: Boolean(edge?.condition),
      condition: edge?.condition ?? null,
      optional: Boolean(edge?.optional),
      // A real mix (several signals summing) vs a selection of one of them.
      merge: converges && !selected,
      switched_merge: selected,
      cycle: path.has(key),
      truncated: false,
      children: [],
    };
    budget.count += 1;
    if (row.cycle) return row;
    if (budget.count >= MAX_FLOW_NODES) {
      // Only a real cut is worth flagging: a node with nowhere left to go is
      // simply the end of the path.
      row.truncated = (out.get(key) || []).length > 0;
      if (row.truncated) budget.truncated = true;
      return row;
    }
    const next = new Set(path);
    next.add(key);
    for (const e of out.get(key) || []) {
      row.children.push(expand(e.to, e, next, budget));
    }
    return row;
  };
  return sources.map((s) => {
    const budget = { count: 0, truncated: false };
    const tree = expand(s.key, null, new Set(), budget);
    // The root carries the summary so the GUI can warn once per tree.
    tree.truncated_tree = budget.truncated;
    return tree;
  });
}
