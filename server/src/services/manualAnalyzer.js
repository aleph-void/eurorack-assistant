// Manual analysis: submit a module's manual PDF to the LLM backend and store a
// summary plus a structured inventory of the module's components (jacks,
// buttons, toggles, ...) with voltage ranges and polarity, and the normalled
// connections between them (defaults that exist until a patch cable overrides
// them) so a patch's real signal path can be traced.

import { extractJsonObject } from './json.js';

export const COMPONENT_TYPES = [
  'input_jack',
  'output_jack',
  // A jack whose role depends on how it is patched: on a (passive) mult any
  // jack of a group can take the input and the rest carry copies out.
  'bidirectional_jack',
  'knob',
  'slider',
  'button',
  'toggle',
  'switch',
  'display',
  'other',
];

export const ANALYSIS_TEMPLATE = (manufacturer, name) => `You are a eurorack modular synthesizer expert. Analyze the attached user manual
for the module "${manufacturer} ${name}" and produce a structured description.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "summary": "A thorough plain-text summary of what the module does and how it works.",
  "components": [
    {
      "type": "input_jack",
      "name": "1V/OCT",
      "description": "Pitch CV input tracking one volt per octave.",
      "voltage_min": -2,
      "voltage_max": 5,
      "polarity": "bipolar",
      "group": null,
      "value_min": null,
      "value_max": null,
      "value_options": null
    },
    {
      "type": "switch",
      "name": "MODE",
      "description": "Selects the filter response.",
      "voltage_min": null,
      "voltage_max": null,
      "polarity": null,
      "group": null,
      "value_min": null,
      "value_max": null,
      "value_options": ["LP", "BP", "HP"]
    }
  ],
  "normalizations": [
    {
      "target": "IN 2",
      "source": "IN 1",
      "source_label": null,
      "description": "Input 2 is normalled to input 1 until a cable is patched into input 2."
    }
  ],
  "routes": [
    {
      "input": "IN 1",
      "output": "MIX OUT",
      "description": "Channel 1 is summed into the mix output."
    }
  ],
  "switches": [
    {
      "name": "Switch section 1",
      "common": "O/I",
      "steps": ["I/O 1", "I/O 2", "I/O 3", "I/O 4"],
      "description": "The common jack connects to one of the four step jacks, advanced by the clock input."
    }
  ]
}

Rules:
- "type" must be one of: ${COMPONENT_TYPES.join(', ')}.
- List EVERY input jack, output jack, knob, slider, button, toggle, and switch
  described in the manual, plus any displays or other controls (type "other").
- For input and output jacks, include "voltage_min" and "voltage_max" in volts
  when the manual states or implies them, and set "polarity" to "unipolar" or
  "bipolar". Use null when unknown.
- For non-jack components, use null for voltage_min, voltage_max, and polarity.
- Use type "bidirectional_jack" for jacks whose direction depends on how they
  are patched — most commonly the interchangeable jacks of a passive mult,
  where any jack of a group can receive the input and the remaining jacks
  output copies of it. For such jacks, set "group" to a label shared by the
  jacks of one interchangeable group (e.g. a 2x2 mult has groups "1" and "2";
  a module with a single group may use null). Jacks with a fixed direction
  (including a buffered mult's dedicated input and outputs) keep type
  "input_jack" or "output_jack" and "group": null.
- "description" explains what the component does.
- "value_min"/"value_max"/"value_options" describe the VALID SETTINGS of a
  control, so a user can write down how a patch is dialed in:
  - For a control with discrete positions (switches, toggles, multi-position
    buttons, stepped knobs), list every position label in "value_options" in
    panel order (e.g. ["LP", "BP", "HP"] or ["off", "on"]).
  - For a continuous control (knobs, sliders), give the ends of the printed
    scale as "value_min" and "value_max" (e.g. 0 and 10, or -5 and 5). If the
    panel has no printed scale, use 0 and 10.
  - Use null for whichever fields do not apply (jacks and displays usually
    have all three null).
- "normalizations" lists every NORMALLED (normalized) connection the manual
  describes: a default connection into an input that exists only while nothing
  is patched into that input. This covers both an input jack normalled to
  another input jack (the source input's signal also feeds the target until
  the target is patched directly) and an output or internal signal normalled
  to an input (e.g. an oscillator normalled to a filter's audio input).
- In each normalization, "target" is the exact "name" of the input-jack
  component that receives the normalled signal. "source" is the exact "name"
  of the component (input or output jack) the signal comes from; when the
  source is an internal signal with no panel jack, use null for "source" and
  name the signal in "source_label" (e.g. "internal oscillator"). Use [] if
  the manual describes no normalled connections.
- "routes" lists every INTERNAL SIGNAL PATH: an input jack whose signal
  (possibly processed) appears at an output jack. A mixer routes each channel
  input to the mix output, a filter routes its audio input to EVERY filter
  output, a VCA routes its signal input to its output, a delay routes its
  input to its wet/mix outputs. Do NOT list control inputs that only modulate
  the signal (pitch CV, cutoff CV, decay CV, clock/trigger inputs) — only
  jacks the signal itself flows through. "input" and "output" are the exact
  component "name"s. Output jacks that appear in no route are treated as
  signal generators (oscillator, noise, LFO, envelope outputs). Use [] for a
  module with no input-to-output signal path.
- "switches" lists every ROUTING SWITCH section (sequential switch, signal
  router): a COMMON jack that connects to exactly ONE of several STEP jacks
  at a time, stepped by a clock or selected by a control. "common" and every
  entry of "steps" are exact component "name"s. On bidirectional switches
  (the same jacks route either direction) give those jacks type
  "bidirectional_jack" but do NOT give them a mult "group" — a switch selects
  one connection, a mult copies to all. Do not list the switch's own
  clock/reset/control inputs as steps. Use [] when the module has no routing
  switch.
`;

function toVoltage(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const VALUE_TYPES = ['min', 'max', 'enum'];

// A control with this many discrete positions or fewer is stored as one
// 'enum' value row per position; anything else becomes a 'min'/'max' pair.
export const MAX_ENUM_VALUES = 4;

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
  if (options.length > 0 && options.length <= MAX_ENUM_VALUES) {
    return options.map((value) => ({ type: 'enum', value }));
  }
  if (options.length > MAX_ENUM_VALUES) {
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
    components.push({
      type,
      name,
      description: raw.description ? String(raw.description).trim() : null,
      voltage_min: toVoltage(raw.voltage_min),
      voltage_max: toVoltage(raw.voltage_max),
      polarity,
      group_label: raw.group ? String(raw.group).trim() || null : null,
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
    normalizations.push({
      target,
      source: source || null,
      source_label: sourceLabel || null,
      description: raw.description ? String(raw.description).trim() : null,
    });
  }
  return normalizations;
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
      output,
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
    const key = `${input.id}|${output.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      input_component_id: input.id,
      output_component_id: output.id,
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
    const key = `${target.id}|${source ? source.id : (n.source_label || n.source).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      target_component_id: target.id,
      source_component_id: source ? source.id : null,
      source_label: source ? null : n.source_label || n.source,
      kind: normalizationKind(source),
      description: n.description,
    });
  }
  return rows;
}

// Analyze one module's manual and persist summary + components +
// normalizations.
export async function analyzeManualForModule(db, backend, module, manualPath) {
  const response = await backend.analyzeDocument(
    ANALYSIS_TEMPLATE(module.manufacturer, module.name),
    manualPath
  );
  const parsed = extractJsonObject(response);
  const summary = String(parsed.summary || '').trim();
  const components = normalizeComponents(parsed.components);
  const normalizations = normalizeNormalizations(parsed.normalizations);
  const routes = normalizeRoutes(parsed.routes);
  const switches = normalizeSwitches(parsed.switches);
  if (!summary && components.length === 0) {
    throw new Error('LLM analysis returned neither a summary nor components');
  }

  const {
    Module,
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentValue,
  } = db.models;
  // Replacing the component inventory and marking the analysis complete is
  // one atomic step — a failure mid-way must not leave the module stripped of
  // its previous components.
  let resolved = [];
  let resolvedRoutes = [];
  let resolvedSwitches = [];
  await db.sequelize.transaction(async (transaction) => {
    // component_values cascade with their components in real Postgres, but
    // the explicit destroy keeps pg-mem (tests) honest too.
    const previous = await ModuleComponent.findAll({
      where: { module_id: module.id },
      attributes: ['id'],
      transaction,
    });
    if (previous.length > 0) {
      await ComponentValue.destroy({
        where: { component_id: previous.map((c) => c.id) },
        transaction,
      });
    }
    const previousSwitches = await ComponentSwitch.findAll({
      where: { module_id: module.id },
      attributes: ['id'],
      transaction,
    });
    if (previousSwitches.length > 0) {
      await ComponentSwitchStep.destroy({
        where: { switch_id: previousSwitches.map((s) => s.id) },
        transaction,
      });
      await ComponentSwitch.destroy({ where: { module_id: module.id }, transaction });
    }
    await ComponentRoute.destroy({ where: { module_id: module.id }, transaction });
    await ComponentNormalization.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.bulkCreate(
      components.map(({ values, ...c }) => ({ ...c, module_id: module.id })),
      { transaction }
    );
    // Re-read the freshly created components to resolve normalization names
    // to component ids.
    const created = await ModuleComponent.findAll({
      where: { module_id: module.id },
      order: [['id', 'ASC']],
      transaction,
    });
    resolved = resolveNormalizations(normalizations, created);
    if (resolved.length > 0) {
      await ComponentNormalization.bulkCreate(
        resolved.map((n) => ({ ...n, module_id: module.id })),
        { transaction }
      );
    }
    resolvedRoutes = resolveRoutes(routes, created);
    if (resolvedRoutes.length > 0) {
      await ComponentRoute.bulkCreate(
        resolvedRoutes.map((r) => ({ ...r, module_id: module.id })),
        { transaction }
      );
    }
    resolvedSwitches = resolveSwitches(switches, created);
    for (const s of resolvedSwitches) {
      const row = await ComponentSwitch.create(
        {
          module_id: module.id,
          name: s.name,
          common_component_id: s.common_component_id,
          description: s.description,
        },
        { transaction }
      );
      await ComponentSwitchStep.bulkCreate(
        s.step_component_ids.map((componentId, i) => ({
          switch_id: row.id,
          component_id: componentId,
          position: i + 1,
        })),
        { transaction }
      );
    }
    // bulkCreate assigns serial ids in input order and `created` is read back
    // ordered by id, so created[i] is components[i]'s row.
    const valueRows = components.flatMap((c, i) =>
      c.values.map((v) => ({ ...v, component_id: created[i].id }))
    );
    if (valueRows.length > 0) {
      await ComponentValue.bulkCreate(valueRows, { transaction });
    }
    await Module.update(
      { summary, analysis_status: 'complete' },
      { where: { id: module.id }, transaction }
    );
  });
  return {
    summary,
    components,
    normalizations: resolved,
    routes: resolvedRoutes,
    switches: resolvedSwitches,
  };
}
