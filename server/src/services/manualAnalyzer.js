// Manual analysis: submit a module's manual PDF to the LLM backend and store a
// summary plus a structured inventory of the module's components (jacks,
// buttons, toggles, ...) with voltage ranges and polarity.

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

// Analyze one module's manual and persist summary + components.
export async function analyzeManualForModule(db, backend, module, manualPath) {
  const response = await backend.analyzeDocument(
    ANALYSIS_TEMPLATE(module.manufacturer, module.name),
    manualPath
  );
  const parsed = extractJsonObject(response);
  const summary = String(parsed.summary || '').trim();
  const components = normalizeComponents(parsed.components);
  if (!summary && components.length === 0) {
    throw new Error('LLM analysis returned neither a summary nor components');
  }

  const { Module, ModuleComponent } = db.models;
  // Replacing the component inventory and marking the analysis complete is
  // one atomic step — a failure mid-way must not leave the module stripped of
  // its previous components.
  await db.sequelize.transaction(async (transaction) => {
    await ModuleComponent.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.bulkCreate(
      components.map((c) => ({ ...c, module_id: module.id })),
      { transaction }
    );
    await Module.update(
      { summary, analysis_status: 'complete' },
      { where: { id: module.id }, transaction }
    );
  });
  return { summary, components };
}
