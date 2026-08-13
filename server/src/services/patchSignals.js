// Tracing normalled connections through a patch. A normalization is a
// default connection that exists only while nothing overrides it, so within a
// patch each one is either ACTIVE or OVERRIDDEN. What overrides it is usually
// a cable patched INTO its target input — but not always: an output normalled
// to another output (Vhikk X's L out feeding its R out for a mono sum) is
// cancelled by a cable patched OUT of the other jack instead, which is what
// break_component_id / break_on record.
//
// An active normalization's actual signal is found by following the chain: a
// target normalled to an output carries that output; one normalled to another
// INPUT carries whatever arrives there — the cable patched into it, or,
// transitively, that input's own normalizations. Chains are cycle-guarded and
// depth-capped, and may cross between a host and its expander panel, so every
// step is keyed by (instance, jack) rather than by jack alone.
//
// Paths that depend on a control position (a switch choosing WHICH signal is
// normalled to an input) are resolved by buildPatchTopology before they get
// here: a position the patch rules out never appears, and one it has not
// recorded arrives flagged `exclusive` — a possibility, not a certainty.

import { engagedPatchModuleIds } from './patchTopology.js';

export const MAX_NORMAL_DEPTH = 10;

// topology: the result of buildPatchTopology().
//
// Returns one row per (module instance, normalization):
//   { patch_module_id, normalization_id, target_component_id,
//     target_component_name, source_component_id, source_component_name,
//     source_label, kind, description, active, overriding_cable_id,
//     condition, alt_group, exclusive,
//     signals: [{ kind: 'cable'|'output'|'internal'|'none', via: [...], ... }] }
// `via` lists the intermediate input names a chained signal passes through.
export function resolveNormalledSignals(topology) {
  const {
    jacksByPatchModule = new Map(),
    normalizations = [],
    settings = [],
    links = [],
    cables = [],
  } = topology || {};

  // Like the signal flow, this is a picture of THIS patch, not of the rack it
  // was snapshotted from: the defaults inside a module nothing is plugged
  // into are the module's business, not the patch's.
  const engaged = engagedPatchModuleIds({ cables, settings, links });

  const jackAt = (pmId, componentId) =>
    (jacksByPatchModule.get(pmId) || []).find((c) => c.id === componentId) || null;
  const nameAt = (pmId, componentId) => jackAt(pmId, componentId)?.name ?? `#${componentId}`;

  const cableInto = new Map();
  const cableById = new Map();
  for (const c of cables) {
    cableInto.set(`${c.to_patch_module_id}:${c.to_component_id}`, c);
    cableById.set(c.id, c);
  }

  // Every normalization landing on a given (instance, jack).
  const normsByTarget = new Map();
  for (const n of normalizations) {
    const key = `${n.target_patch_module_id}:${n.target_component_id}`;
    if (!normsByTarget.has(key)) normsByTarget.set(key, []);
    normsByTarget.get(key).push(n);
  }

  // The cable that cancels a normalization (resolved by buildPatchTopology,
  // which knows whether this default breaks on a cable in or a cable out).
  const overridingCable = (n) =>
    n.broken_by_cable_id ? (cableById.get(n.broken_by_cable_id) ?? null) : null;

  // Every signal arriving at a jack: the cable patched into it, or what its
  // own normalizations deliver.
  const feedsOf = (pmId, componentId, via, visited) => {
    const cable = cableInto.get(`${pmId}:${componentId}`);
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
    const key = `${pmId}:${componentId}`;
    if (visited.has(key) || via.length >= MAX_NORMAL_DEPTH) return [{ kind: 'none', via }];
    const targetNorms = (normsByTarget.get(key) || []).filter((n) => !overridingCable(n));
    if (targetNorms.length === 0) return [{ kind: 'none', via }];
    const next = new Set(visited);
    next.add(key);
    return targetNorms.flatMap((n) => signalOf(n, via, next));
  };

  // The signal one normalization delivers to its target.
  const signalOf = (n, via, visited) => {
    if (!n.source_component_id) {
      return [{ kind: 'internal', label: n.source_label || 'internal signal', via }];
    }
    const source = jackAt(n.source_patch_module_id, n.source_component_id);
    if (!source) return [{ kind: 'none', via }];
    // Outputs (and mult jacks) produce the signal themselves; an input source
    // only relays whatever reaches it.
    if (source.type !== 'input_jack') {
      return [
        {
          kind: 'output',
          patch_module_id: n.source_patch_module_id,
          component_id: source.id,
          component_name: source.name,
          via,
        },
      ];
    }
    return feedsOf(n.source_patch_module_id, source.id, [...via, source.name], visited);
  };

  return normalizations
    .filter((n) => engaged.has(n.target_patch_module_id))
    .map((n) => {
      const overriding = overridingCable(n);
      return {
        patch_module_id: n.patch_module_id,
        normalization_id: n.id,
        target_patch_module_id: n.target_patch_module_id,
        target_component_id: n.target_component_id,
        target_component_name: nameAt(n.target_patch_module_id, n.target_component_id),
        source_patch_module_id: n.source_patch_module_id,
        source_component_id: n.source_component_id,
        source_component_name: n.source_component_id
          ? (jackAt(n.source_patch_module_id, n.source_component_id)?.name ?? null)
          : null,
        source_label: n.source_label,
        kind: n.kind,
        // What cancels it, so the GUI can explain an unexpected 'overridden'.
        break_component_name: nameAt(n.break_patch_module_id, n.break_component_id),
        break_on: n.break_on,
        // Which control position this default belongs to, when it has one.
        condition: n.condition,
        alt_group: n.alt_group,
        exclusive: n.exclusive,
        description: n.description,
        active: !overriding,
        overriding_cable_id: overriding ? overriding.id : null,
        signals: overriding
          ? []
          : signalOf(n, [], new Set([`${n.target_patch_module_id}:${n.target_component_id}`])),
      };
    });
}
