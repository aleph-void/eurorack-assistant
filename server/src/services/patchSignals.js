// Tracing normalled connections through a patch. A normalization is a
// default connection that exists only while nothing is patched into its
// target input, so within a patch each one is either ACTIVE (no cable in the
// target) or OVERRIDDEN by the cable plugged into it. An active
// normalization's actual signal is found by following the chain: a target
// normalled to an output carries that output; one normalled to another INPUT
// carries whatever arrives there — the cable patched into it, or,
// transitively, that input's own normalizations. Chains are cycle-guarded
// and depth-capped.

export const MAX_NORMAL_DEPTH = 10;

// patchModules: [{ id, module_id }] (one per instance; dead modules skipped)
// componentsByModule: Map(module_id -> [{ id, type, name, ... }])
// normalizationsByModule: Map(module_id -> [normalization rows])
// cables: [{ id, from_patch_module_id, from_component_id, from_component_name,
//            to_patch_module_id, to_component_id }]
//
// Returns one row per (module instance, normalization):
//   { patch_module_id, normalization_id, target_component_id,
//     target_component_name, source_component_id, source_component_name,
//     source_label, kind, description, active, overriding_cable_id,
//     signals: [{ kind: 'cable'|'output'|'internal'|'none', via: [...], ... }] }
// `via` lists the intermediate input names a chained signal passes through.
export function resolveNormalledSignals({
  patchModules,
  componentsByModule,
  normalizationsByModule,
  cables,
}) {
  const cableInto = new Map();
  for (const c of cables) cableInto.set(`${c.to_patch_module_id}:${c.to_component_id}`, c);

  const rows = [];
  for (const pm of patchModules) {
    if (!pm.module_id) continue;
    const norms = normalizationsByModule.get(pm.module_id) || [];
    if (norms.length === 0) continue;
    const components = componentsByModule.get(pm.module_id) || [];
    const byId = new Map(components.map((c) => [c.id, c]));
    const normsByTarget = new Map();
    for (const n of norms) {
      if (!normsByTarget.has(n.target_component_id)) normsByTarget.set(n.target_component_id, []);
      normsByTarget.get(n.target_component_id).push(n);
    }

    // Every signal arriving at an input on this instance: the cable patched
    // into it, or what its own normalizations deliver.
    const feedsOf = (componentId, via, visited) => {
      const cable = cableInto.get(`${pm.id}:${componentId}`);
      if (cable) {
        return [
          {
            kind: 'cable',
            cable_id: cable.id,
            from_patch_module_id: cable.from_patch_module_id,
            from_component_id: cable.from_component_id,
            from_component_name: cable.from_component_name,
            via,
          },
        ];
      }
      if (visited.has(componentId) || via.length >= MAX_NORMAL_DEPTH) {
        return [{ kind: 'none', via }];
      }
      const targetNorms = normsByTarget.get(componentId) || [];
      if (targetNorms.length === 0) return [{ kind: 'none', via }];
      const next = new Set(visited);
      next.add(componentId);
      return targetNorms.flatMap((n) => signalOf(n, via, next));
    };

    // The signal one normalization delivers to its target.
    const signalOf = (n, via, visited) => {
      if (!n.source_component_id) {
        return [{ kind: 'internal', label: n.source_label || 'internal signal', via }];
      }
      const source = byId.get(n.source_component_id);
      if (!source) return [{ kind: 'none', via }];
      // Outputs (and mult jacks) produce the signal themselves; an input
      // source only relays whatever reaches it.
      if (source.type !== 'input_jack') {
        return [{ kind: 'output', component_id: source.id, component_name: source.name, via }];
      }
      return feedsOf(source.id, [...via, source.name], visited);
    };

    for (const n of norms) {
      const target = byId.get(n.target_component_id);
      const overriding = cableInto.get(`${pm.id}:${n.target_component_id}`);
      rows.push({
        patch_module_id: pm.id,
        normalization_id: n.id,
        target_component_id: n.target_component_id,
        target_component_name: target ? target.name : `#${n.target_component_id}`,
        source_component_id: n.source_component_id,
        source_component_name: n.source_component_id
          ? (byId.get(n.source_component_id)?.name ?? null)
          : null,
        source_label: n.source_label,
        kind: n.kind,
        description: n.description,
        active: !overriding,
        overriding_cable_id: overriding ? overriding.id : null,
        signals: overriding
          ? []
          : signalOf(n, [], new Set([n.target_component_id])),
      });
    }
  }
  return rows;
}
