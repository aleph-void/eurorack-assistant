// A patch, written out as text for the LLM.
//
// Asking "why is there no sound at the output" is unanswerable from the
// module manuals alone: the answer lives in what is plugged into what, how the
// controls are set, which normalled connections a cable has cancelled and
// where the signal actually ends up. This renders exactly the picture the GUI
// shows — the resolved patch from loadPatchDetail — as prose the model reads
// alongside the manuals.
//
// It is a pure function of that JSON so it can be unit-tested without a
// database, like captureTextDocument.

import { engagedPatchModuleIds } from './patchTopology.js';

const label = (modulesById, patchModuleId) => {
  const pm = modulesById.get(patchModuleId);
  if (!pm) return '(removed module)';
  const base = `${pm.manufacturer ?? ''} ${pm.module_name ?? ''}`.trim() || 'unnamed module';
  const numbered = pm.instance > 1 ? `${base} #${pm.instance}` : base;
  return pm.label ? `${numbered} (${pm.label})` : numbered;
};

const EDGE_TEXT = {
  cable: 'patch cable',
  route: 'internal signal path',
  normal: 'normalled connection',
  mult: 'mult copy',
  switch: 'switch position',
  bridge: 'bridged link',
};

function conditionText(condition) {
  if (!condition) return '';
  if (condition.state === 'selected') {
    return ` [with ${condition.component_name} set to ${condition.value}]`;
  }
  if (condition.state === 'unset') {
    return ` [only when ${condition.component_name} is set to ${condition.value}, which this patch does not record]`;
  }
  return ` [only when ${condition.component_name} is set to ${condition.value}]`;
}

export function patchTextDocument(patch) {
  const modules = patch.modules ?? [];
  const modulesById = new Map(modules.map((m) => [m.id, m]));
  const name = (id) => label(modulesById, id);
  const cables = patch.cables ?? [];
  const settings = patch.settings ?? [];
  const normalizations = patch.normalizations ?? [];
  const groups = patch.groups ?? [];
  const groupName = new Map(groups.map((g) => [g.id, g.name]));

  const lines = [];
  lines.push(`# Patch: ${patch.name}`);
  // A patch built from a whole system spans several racks, and saying "Rack"
  // of it would send an answer looking for one case.
  if (patch.system_name) lines.push(`System: ${patch.system_name}`);
  else if (patch.rack_name) lines.push(`Rack: ${patch.rack_name}`);
  if (patch.description) lines.push('', patch.description);

  // Only the instances the patch uses. A patch snapshots the whole rack, and
  // listing every module in the case as if it were patched is exactly the
  // kind of thing that sends an answer down the wrong path.
  const used = engagedPatchModuleIds({ cables, settings, links: patch.links ?? [] });

  lines.push('', '## Modules in this patch');
  // Across a system, which case a module stands in is part of what it is —
  // "patch its output into the other rack" is a different instruction from
  // one about two neighbours on the same rail.
  const spansRacks = new Set(modules.map((m) => m.rack_name).filter(Boolean)).size > 1;
  const inUse = modules.filter((m) => used.has(m.id));
  if (inUse.length === 0) {
    lines.push('Nothing is patched yet.');
  } else {
    for (const pm of inUse) {
      const notes = [];
      if (pm.external) notes.push('gear outside the rack');
      else if (!pm.live) notes.push('not in the rack this patch was made from');
      if (spansRacks && pm.rack_name) notes.push(`in rack "${pm.rack_name}"`);
      if (pm.group_id && groupName.has(pm.group_id)) notes.push(`in the "${groupName.get(pm.group_id)}" group`);
      lines.push(`- ${name(pm.id)}${notes.length ? ` — ${notes.join(', ')}` : ''}`);
    }
  }
  const idle = modules.filter((m) => !used.has(m.id));
  if (idle.length > 0) {
    lines.push(
      '',
      `Also in the rack but not patched into anything: ${idle
        .map((m) => `${m.manufacturer} ${m.module_name}`.trim())
        .join(', ')}.`
    );
  }

  lines.push('', '## Cables');
  if (cables.length === 0) {
    lines.push('No patch cables.');
  } else {
    for (const c of cables) {
      const flags = [];
      if (c.optional) flags.push('optional');
      if (c.stacked) flags.push('stacked onto the source jack');
      if (c.alt_group) flags.push(`one of the alternatives in "${c.alt_group}"`);
      if (c.note) flags.push(c.note);
      lines.push(
        `- ${name(c.from_patch_module_id)} "${c.from_component_name}" → ` +
          `${name(c.to_patch_module_id)} "${c.to_component_name}"` +
          (flags.length ? ` (${flags.join('; ')})` : '')
      );
    }
  }

  lines.push('', '## Control settings');
  if (settings.length === 0) {
    lines.push('No control positions recorded — assume nothing about how the controls are set.');
  } else {
    // Two kinds of thing sit in this list: the position of a control on the
    // panel, and the value of a MENU PARAMETER — a setting a module keeps
    // behind an encoder and a screen, which belongs to a jack or to the
    // module itself rather than to anything you can see. Saying which is
    // which is the difference between "the knob is at 4" and "output 4 is
    // set to divide the clock by 4".
    for (const s of settings) {
      const where = s.component_name ? ` "${s.component_name}"` : '';
      const what = s.parameter_name ? ` menu setting "${s.parameter_name}"` : '';
      lines.push(`- ${name(s.patch_module_id)}${where}${what}: ${s.value}`);
    }
  }

  if (normalizations.length > 0) {
    lines.push(
      '',
      '## Normalled (default) connections',
      'Each module’s built-in default connections, resolved against this patch:'
    );
    for (const n of normalizations) {
      const source = n.source_component_name
        ? `"${n.source_component_name}"`
        : `the internal signal "${n.source_label}"`;
      const head = `- ${name(n.patch_module_id)}: "${n.target_component_name}" is normalled to ${source}${conditionText(n.condition)}`;
      if (!n.active) {
        lines.push(`${head} — CANCELLED in this patch by a cable ${n.break_on === 'cable_out' ? 'out of' : 'into'} "${n.break_component_name ?? n.target_component_name}"`);
        continue;
      }
      const signals = (n.signals ?? []).map((s) => {
        if (s.kind === 'cable') {
          const via = s.via?.length ? ` (via ${s.via.join(' → ')})` : '';
          return `"${s.from_component_name}" from ${name(s.from_patch_module_id)}${via}`;
        }
        if (s.kind === 'output') return `"${s.component_name}" on the same module`;
        if (s.kind === 'internal') return s.label;
        return 'nothing — the chain ends at an unpatched input';
      });
      lines.push(`${head} — ACTIVE, carrying ${signals.length ? signals.join('; ') : 'no signal'}`);
    }
  }

  const flow = patch.flow ?? [];
  if (flow.length > 0) {
    lines.push(
      '',
      '## Signal flow',
      'Every signal source traced to everywhere it goes, through cables, mult copies,',
      'normalled connections, each module’s internal paths, expanders and bridges.',
      'Indentation is one hop; the arrow says what carries it.'
    );
    const walk = (node, depth) => {
      const indent = '  '.repeat(depth);
      const via = node.via ? `${EDGE_TEXT[node.via] ?? node.via} → ` : '';
      const flags = [];
      if (depth === 0) flags.push(node.kind === 'internal' ? 'internal source' : 'signal generator');
      if (node.port_kind) flags.push(String(node.port_kind).replace(/_/g, ' '));
      if (node.optional) flags.push('optional cable');
      if (node.merge) flags.push('several signals merge here');
      if (node.switched_merge) flags.push('one of these signals at a time, chosen by a switch');
      else if (node.switched) flags.push('only in one switch position');
      if (node.conditional) flags.push(conditionText(node.condition).trim().replace(/^\[|\]$/g, ''));
      if (node.cycle) flags.push('feedback loop back to a jack already in this path');
      if (node.truncated) flags.push('path not followed further');
      lines.push(
        `${indent}- ${via}${name(node.patch_module_id)} "${node.name}"` +
          (flags.length ? ` [${flags.join('; ')}]` : '')
      );
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    for (const tree of flow) walk(tree, 0);
  }

  return lines.join('\n');
}
