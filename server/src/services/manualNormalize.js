// Turning what the model answered into rows.
//
// Every function here is total: it takes whatever came back — a missing
// list, a type outside the vocabulary, a voltage written as a word, a
// normalization naming a component that does not exist — and returns the
// rows that are actually storable, dropping the rest. Nothing here talks to
// the database or the LLM, which is what makes it all directly testable.

import { BREAK_MODES, COMPONENT_TYPES, PORT_KINDS } from './manualVocabulary.js';

function toVoltage(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const VALUE_TYPES = ['min', 'max', 'enum'];

// A control with this many discrete positions or fewer is stored as one
// 'enum' value row per position; anything else becomes a 'min'/'max' pair.
export const MAX_ENUM_VALUES = 4;

// ... except on controls whose positions are discrete by nature. A knob with
// a long list of labels is really a range, but a mode switch with sixteen
// algorithms has sixteen positions, and collapsing them to first-and-last
// loses the ones in between — including any a signal path depends on
// (Ornament and Crime's apps, Vhikk X's algorithms, Plaits' models).
export const MAX_DISCRETE_ENUM_VALUES = 24;
const DISCRETE_TYPES = ['switch', 'toggle', 'button'];

// Panel names, compared loosely: a manual writes "Atlx" or "Intellijel
// Atlantix" where the module record says "Atlantix".
const normalizePanel = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Whether a "panel" from the analysis names THIS module rather than another
// one the same manual documents. A panel name more specific than the module's
// own ("Intellijel Atlantix" while analyzing "Atlantix") still names it; a
// shorter one ("Quad Operator" while analyzing "Quad Operator Algo
// Extension") names something else — nearly always the host.
export function panelNamesModule(panel, module) {
  const p = normalizePanel(panel);
  if (!p) return true;
  const name = normalizePanel(module.name);
  const full = normalizePanel(`${module.manufacturer} ${module.name}`);
  if (p === name || p === full) return true;
  return ` ${p} `.includes(` ${name} `);
}

// Split an analysis's components into the ones on this module's panel and the
// ones the manual attributes to another panel it also documents.
export function splitByPanel(components, module) {
  const own = components.filter((c) => panelNamesModule(c.panel, module));
  // Never let panel tagging strip a module of its whole inventory: if the
  // analysis attributed everything elsewhere, the tags are not trustworthy,
  // so the module keeps what its manual describes, as it did before.
  if (own.length === 0) return { own: components, other: [], panelsUsable: false };
  return {
    own,
    other: components.filter((c) => !panelNamesModule(c.panel, module)),
    panelsUsable: true,
  };
}

// Turn one raw component's value_min/value_max/value_options into
// component_values rows ({ type, value }). Discrete positions win over a
// range when both are given; more positions than MAX_ENUM_VALUES degrade to
// the first and last position (they are listed in panel order).
export function normalizeComponentValues(raw) {
  const seen = new Set();
  const options = (Array.isArray(raw.value_options) ? raw.value_options : [])
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => {
      if (!v || seen.has(v.toLowerCase())) return false;
      seen.add(v.toLowerCase());
      return true;
    });
  const type = String(raw.type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const cap = DISCRETE_TYPES.includes(type) ? MAX_DISCRETE_ENUM_VALUES : MAX_ENUM_VALUES;
  if (options.length > 0 && options.length <= cap) {
    return options.map((value) => ({ type: 'enum', value }));
  }
  if (options.length > cap) {
    return [
      { type: 'min', value: options[0] },
      { type: 'max', value: options[options.length - 1] },
    ];
  }
  const values = [];
  const min = raw.value_min === null || raw.value_min === undefined ? '' : String(raw.value_min).trim();
  const max = raw.value_max === null || raw.value_max === undefined ? '' : String(raw.value_max).trim();
  if (min !== '') values.push({ type: 'min', value: min });
  if (max !== '') values.push({ type: 'max', value: max });
  return values;
}

// { control, value } naming the control position a signal path depends on, or
// null when the path is unconditional.
export function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const control = String(raw.control ?? raw.component ?? '').trim();
  const value = String(raw.value ?? '').trim();
  if (!control || !value) return null;
  return { control, value };
}

// Turn a name-based condition into ids against the stored components. An
// unresolvable control drops the condition rather than the path — a path that
// exists in one switch position is still a real path.
function resolveCondition(condition, byName) {
  if (!condition) return { condition_component_id: null, condition_value: null };
  const control = byName.get(condition.control.toLowerCase());
  if (!control) return { condition_component_id: null, condition_value: null };
  return { condition_component_id: control.id, condition_value: condition.value };
}

const altGroup = (raw) => String(raw?.alternative_group ?? raw?.alt_group ?? '').trim() || null;

export function normalizeComponents(rawComponents) {
  if (!Array.isArray(rawComponents)) return [];
  const components = [];
  for (const raw of rawComponents) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (!name) continue;
    let type = String(raw.type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!COMPONENT_TYPES.includes(type)) type = 'other';
    let polarity = raw.polarity ? String(raw.polarity).trim().toLowerCase() : null;
    if (polarity !== 'unipolar' && polarity !== 'bipolar') polarity = null;
    let portKind = raw.port_kind
      ? String(raw.port_kind).trim().toLowerCase().replace(/[\s-]+/g, '_')
      : null;
    if (portKind && !PORT_KINDS.includes(portKind)) portKind = 'other';
    components.push({
      type,
      name,
      description: raw.description ? String(raw.description).trim() : null,
      voltage_min: toVoltage(raw.voltage_min),
      voltage_max: toVoltage(raw.voltage_max),
      polarity,
      group_label: raw.group ? String(raw.group).trim() || null : null,
      port_kind: portKind,
      // Not a module_components column: which panel the manual puts this
      // component on, used to keep a host's jacks off its expander's record.
      panel: raw.panel ? String(raw.panel).trim() || null : null,
      // Not a module_components column: split into component_values rows once
      // the component records exist.
      values: normalizeComponentValues(raw),
    });
  }
  return components;
}

export function normalizeNormalizations(rawNormalizations) {
  if (!Array.isArray(rawNormalizations)) return [];
  const normalizations = [];
  for (const raw of rawNormalizations) {
    if (!raw || typeof raw !== 'object') continue;
    const target = String(raw.target || '').trim();
    const source = String(raw.source || '').trim();
    const sourceLabel = String(raw.source_label || '').trim();
    if (!target || (!source && !sourceLabel)) continue;
    const rawBreak = raw.break && typeof raw.break === 'object' ? raw.break : null;
    const breakJack = String(rawBreak?.jack ?? rawBreak?.component ?? '').trim();
    let breakOn = String(rawBreak?.on ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!BREAK_MODES.includes(breakOn)) breakOn = 'cable_in';
    normalizations.push({
      target,
      target_panel: raw.target_panel ? String(raw.target_panel).trim() || null : null,
      source: source || null,
      source_panel: raw.source_panel ? String(raw.source_panel).trim() || null : null,
      source_label: sourceLabel || null,
      condition: normalizeCondition(raw.condition),
      alt_group: altGroup(raw),
      break_jack: breakJack || null,
      break_on: breakOn,
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return normalizations;
}

export const EXPANDER_ROLES = ['expander', 'host'];

// Other panels the manual presents as part of this instrument. Only the name
// is known here — turning it into a link between two module records happens
// once both exist (see services/moduleLinks.js).
export function normalizeExpanders(rawExpanders) {
  if (!Array.isArray(rawExpanders)) return [];
  const expanders = [];
  const seen = new Set();
  for (const raw of rawExpanders) {
    if (!raw) continue;
    const name = String(typeof raw === 'string' ? raw : (raw.name ?? '')).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    let role = String(raw.role || 'expander').trim().toLowerCase();
    if (!EXPANDER_ROLES.includes(role)) role = 'expander';
    expanders.push({
      name,
      role,
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return expanders;
}

export function normalizePairs(rawPairs) {
  if (!Array.isArray(rawPairs)) return [];
  const pairs = [];
  for (const raw of rawPairs) {
    if (!raw || typeof raw !== 'object') continue;
    const a = String(raw.a ?? raw.left ?? '').trim();
    const b = String(raw.b ?? raw.right ?? '').trim();
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
    pairs.push({
      a,
      b,
      kind: String(raw.kind || '').trim().toLowerCase() || 'stereo',
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return pairs;
}

// Two jacks of the module that carry the two halves of one signal. Both ends
// must resolve to jacks, and a jack belongs to at most one pair.
export function resolvePairs(pairs, components) {
  const byName = new Map();
  for (const c of components) {
    const key = c.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  const rows = [];
  const paired = new Set();
  for (const p of pairs) {
    const a = byName.get(p.a.toLowerCase());
    const b = byName.get(p.b.toLowerCase());
    if (!a || !b || a.id === b.id) continue;
    if (!a.type.endsWith('_jack') || !b.type.endsWith('_jack')) continue;
    if (paired.has(a.id) || paired.has(b.id)) continue;
    paired.add(a.id);
    paired.add(b.id);
    rows.push({
      a_component_id: a.id,
      b_component_id: b.id,
      kind: p.kind,
      description: p.description,
    });
  }
  return rows;
}

export function normalizeRoutes(rawRoutes) {
  if (!Array.isArray(rawRoutes)) return [];
  const routes = [];
  for (const raw of rawRoutes) {
    if (!raw || typeof raw !== 'object') continue;
    const input = String(raw.input || '').trim();
    const output = String(raw.output || '').trim();
    if (!input || !output) continue;
    routes.push({
      input,
      input_panel: raw.input_panel ? String(raw.input_panel).trim() || null : null,
      output,
      output_panel: raw.output_panel ? String(raw.output_panel).trim() || null : null,
      condition: normalizeCondition(raw.condition),
      alt_group: altGroup(raw),
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return routes;
}

// Turn name-based routes from the LLM into rows referencing the stored
// component records. A route must run from a resolved input jack to a
// resolved output jack; anything else is dropped.
export function resolveRoutes(routes, components) {
  const byName = new Map();
  for (const c of components) {
    const key = c.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  const rows = [];
  const seen = new Set();
  for (const r of routes) {
    const input = byName.get(r.input.toLowerCase());
    const output = byName.get(r.output.toLowerCase());
    if (!input || !output) continue;
    if (input.type !== 'input_jack' || output.type !== 'output_jack') continue;
    const condition = resolveCondition(r.condition, byName);
    // The same pair of jacks in two switch positions is two distinct paths.
    const key = `${input.id}|${output.id}|${condition.condition_component_id ?? ''}|${(
      condition.condition_value ?? ''
    ).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      input_component_id: input.id,
      output_component_id: output.id,
      ...condition,
      alt_group: r.alt_group ?? null,
      description: r.description,
    });
  }
  return rows;
}

export function normalizeSwitches(rawSwitches) {
  if (!Array.isArray(rawSwitches)) return [];
  const switches = [];
  for (const raw of rawSwitches) {
    if (!raw || typeof raw !== 'object') continue;
    const common = String(raw.common || '').trim();
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);
    if (!common || steps.length === 0) continue;
    switches.push({
      name: raw.name ? String(raw.name).trim() || null : null,
      common,
      steps,
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return switches;
}

// Turn name-based switch sections from the LLM into rows referencing the
// stored components. Common and steps must all resolve to jacks; steps
// dedupe, never include the common, and at least one must survive.
export function resolveSwitches(switches, components) {
  const byName = new Map();
  for (const c of components) {
    const key = c.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  const isJack = (c) => c && c.type.endsWith('_jack');
  const rows = [];
  const seenCommons = new Set();
  for (const s of switches) {
    const common = byName.get(s.common.toLowerCase());
    if (!isJack(common) || seenCommons.has(common.id)) continue;
    const stepIds = [];
    for (const stepName of s.steps) {
      const step = byName.get(stepName.toLowerCase());
      if (!isJack(step) || step.id === common.id || stepIds.includes(step.id)) continue;
      stepIds.push(step.id);
    }
    if (stepIds.length === 0) continue;
    seenCommons.add(common.id);
    rows.push({
      name: s.name,
      common_component_id: common.id,
      step_component_ids: stepIds,
      description: s.description,
    });
  }
  return rows;
}

// Where a normalled signal comes from: another input jack (whose patched
// signal carries over), an output jack (a bidirectional jack counts as a
// signal source too), or — when there is no source component — an internal
// signal with no panel representation.
export function normalizationKind(sourceComponent) {
  if (sourceComponent?.type === 'input_jack') return 'input';
  if (sourceComponent?.type === 'output_jack' || sourceComponent?.type === 'bidirectional_jack') {
    return 'output';
  }
  return 'internal';
}

// Turn name-based normalizations from the LLM into rows referencing the
// stored component records. The target must resolve to a component; a named
// source that doesn't resolve is kept as a label so the connection isn't
// lost. kind reflects where the signal comes from: another input jack, an
// output jack, or an internal signal with no panel component.
export function resolveNormalizations(normalizations, components) {
  const byName = new Map();
  for (const c of components) {
    const key = c.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  const rows = [];
  const seen = new Set();
  for (const n of normalizations) {
    const target = byName.get(n.target.toLowerCase());
    if (!target) continue;
    const source = n.source ? byName.get(n.source.toLowerCase()) : undefined;
    if (source && source.id === target.id) continue;
    const condition = resolveCondition(n.condition, byName);
    // Two switch positions normalling different sources to one input are two
    // rows, so the condition is part of a normalization's identity.
    const key = `${target.id}|${source ? source.id : (n.source_label || n.source).toLowerCase()}|${
      condition.condition_component_id ?? ''
    }|${(condition.condition_value ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A break jack that doesn't resolve (or is the target itself) falls back
    // to the default: the normal is broken by a cable into the target.
    const breakJack = n.break_jack ? byName.get(n.break_jack.toLowerCase()) : null;
    const breaksElsewhere = breakJack && breakJack.id !== target.id;
    rows.push({
      target_component_id: target.id,
      source_component_id: source ? source.id : null,
      source_label: source ? null : n.source_label || n.source,
      kind: normalizationKind(source),
      ...condition,
      alt_group: n.alt_group ?? null,
      break_component_id: breaksElsewhere ? breakJack.id : null,
      break_on: breaksElsewhere ? n.break_on || 'cable_in' : 'cable_in',
      description: n.description,
    });
  }
  return rows;
}
