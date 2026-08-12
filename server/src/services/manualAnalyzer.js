// Manual analysis: submit a module's manual PDF to the LLM backend and store a
// summary plus a structured inventory of the module's components (jacks,
// buttons, toggles, ...) with voltage ranges and polarity, and the normalled
// connections between them (defaults that exist until a patch cable overrides
// them) so a patch's real signal path can be traced.

import { extractJsonObject } from './json.js';

export const COMPONENT_TYPES = [
  'input_jack',
  'output_jack',
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
      "polarity": "bipolar"
    }
  ],
  "normalizations": [
    {
      "target": "IN 2",
      "source": "IN 1",
      "source_label": null,
      "description": "Input 2 is normalled to input 1 until a cable is patched into input 2."
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
- "description" explains what the component does.
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
`;

function toVoltage(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

// Where a normalled signal comes from: another input jack (whose patched
// signal carries over), an output jack, or — when there is no source
// component — an internal signal with no panel representation.
export function normalizationKind(sourceComponent) {
  if (sourceComponent?.type === 'input_jack') return 'input';
  if (sourceComponent?.type === 'output_jack') return 'output';
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
  if (!summary && components.length === 0) {
    throw new Error('LLM analysis returned neither a summary nor components');
  }

  const { Module, ModuleComponent, ComponentNormalization } = db.models;
  // Replacing the component inventory and marking the analysis complete is
  // one atomic step — a failure mid-way must not leave the module stripped of
  // its previous components.
  let resolved = [];
  await db.sequelize.transaction(async (transaction) => {
    await ComponentNormalization.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.bulkCreate(
      components.map((c) => ({ ...c, module_id: module.id })),
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
    await Module.update(
      { summary, analysis_status: 'complete' },
      { where: { id: module.id }, transaction }
    );
  });
  return { summary, components, normalizations: resolved };
}
