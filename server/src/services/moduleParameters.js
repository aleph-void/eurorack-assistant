// The settings a module keeps in its menu rather than under a knob.
//
// A filter's LP/BP/HP switch is a component with three positions, and
// component_values says so. Pamela's Pro Workout has one encoder, one screen
// and eight output jacks: every output's clock division, waveform, level,
// pulse width, phase, euclidean pattern and skip probability is chosen by
// turning that one encoder in a menu. None of them is a thing on the panel,
// there are a hundred of them, and a dozen of them belong to a single jack —
// which is exactly what module_parameters records, and what a patch can then
// say it dialed in.
//
// The extraction is a PURE FILL, like componentDescriber: a parameter that is
// already recorded is never rewritten, and a parameter that already has its
// options listed is left alone. What the pass may do is add parameters the
// module does not have yet, and fill in the option list of one that has none.
// The user's corrections on the module page always win.

import { extractJsonObject } from './json.js';
import { parameterJson, parameterOptionJson } from './moduleJson.js';

// How a parameter's value is chosen: one of a listed set, a number in a
// range, or free text for the handful a manual describes without bounding.
export const PARAMETER_VALUE_TYPES = ['enum', 'number', 'text'];

// Every menu parameter of the given modules, options attached, grouped by
// module. One flat query per table (pg-mem-friendly) and the grouping done in
// JS, because both the module page and a whole-studio patch payload need the
// same shape. `describe: false` drops the prose, exactly as a patch payload
// drops a component's description: a studio's worth of parameter and option
// descriptions is a megabyte nothing on the page shows.
export async function parametersByModule(db, moduleIds, { describe = true } = {}) {
  const { ModuleParameter, ModuleParameterOption } = db.models;
  const ids = [...new Set((moduleIds ?? []).filter((id) => id !== null && id !== undefined))];
  const byModule = new Map();
  if (ids.length === 0) return byModule;
  const rows = await ModuleParameter.findAll({
    where: { module_id: ids },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (rows.length === 0) return byModule;
  const optionRows = await ModuleParameterOption.findAll({
    where: { parameter_id: rows.map((r) => r.id) },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const optionsByParameter = new Map();
  for (const o of optionRows) {
    if (!optionsByParameter.has(o.parameter_id)) optionsByParameter.set(o.parameter_id, []);
    const json = parameterOptionJson(o);
    optionsByParameter.get(o.parameter_id).push(describe ? json : { ...json, description: null });
  }
  for (const r of rows) {
    if (!byModule.has(r.module_id)) byModule.set(r.module_id, []);
    const json = parameterJson(r, { options: optionsByParameter.get(r.id) ?? [] });
    byModule.get(r.module_id).push(describe ? json : { ...json, description: null });
  }
  return byModule;
}

const clean = (value, max = 200) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

const key = (componentId, name) =>
  `${componentId ?? 0}:${String(name ?? '').trim().toLowerCase()}`;

export const PARAMETERS_TEMPLATE = (manufacturer, name, components) => {
  const lines = [
    `The attached document(s) are documentation for the Eurorack module "${manufacturer} ${name}".`,
    '',
    'Some modules are configured almost entirely through a MENU: one encoder,',
    'button or screen reaches settings that have no dedicated control on the',
    'front panel. Pamela\'s Pro Workout is the type case — a single encoder sets',
    "each output's clock division, waveform, level, pulse width and more.",
    '',
    'List every such MENU PARAMETER this module has. A parameter is a setting a',
    'user chooses that is NOT simply the position of a knob, slider, switch or',
    'toggle printed on the panel. If the module has no menu at all, answer with',
    'an empty list — do not invent parameters, and do not list the panel',
    'controls themselves.',
  ];
  if (components.length > 0) {
    lines.push(
      '',
      'These are the panel components already recorded for this module. When a',
      'parameter configures one of them — most often an output jack — give that',
      "component's name EXACTLY as it appears here in \"component\":",
      '',
      ...components.map((c) => `- "${c.name}" (${String(c.type).replace(/_/g, ' ')})`)
    );
  }
  lines.push(
    '',
    'Respond with a JSON object of the shape:',
    '{"parameters": [',
    '  {"name": "Clock division / multiplication",',
    '   "component": "OUT 1",',
    '   "group": "Output settings",',
    '   "value_type": "enum",',
    '   "options": [{"value": "/16", "description": "Sixteen times slower than the clock"},',
    '               {"value": "x2", "description": "Twice the clock rate"}],',
    '   "value_min": null, "value_max": null, "unit": null,',
    '   "default": "x1",',
    '   "description": "How fast this output runs against the master clock."}',
    ']}',
    '',
    'Rules:',
    `- "value_type" is one of: ${PARAMETER_VALUE_TYPES.join(', ')}.`,
    '- Use "enum" whenever the manual lists the settings to choose between, and',
    '  put EVERY one of them in "options", in menu order, exactly as the manual',
    '  prints them. This list is the whole point of the answer: a user picks the',
    '  setting from it rather than typing a guess. Where a manual gives a range',
    '  of steps rather than a printed list ("1 to 16"), use "number" with',
    '  "value_min" and "value_max" instead of inventing labels.',
    '- "component" is the panel component the parameter belongs to, or null for',
    '  a parameter of the whole module (a global tempo, a sync source). A',
    '  parameter that exists once PER OUTPUT is one row per output jack, each',
    '  naming its own jack.',
    '- "group" is the menu page or section the manual lists it under, or null.',
    '- "unit" is what the numbers are in ("BPM", "%", "ms"), or null.',
    '- "default" is the value the module starts at, when the manual says.',
    '- "description" is one sentence on what the parameter does.',
    'Respond with JSON only.'
  );
  return lines.join('\n');
};

// Parse one parameter out of the model's answer, or null when there is not
// enough of it to record.
function parseParameter(raw, componentByName) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clean(raw.name);
  if (!name) return null;
  const componentName = clean(raw.component);
  const component = componentName ? componentByName.get(componentName.toLowerCase()) : null;
  let valueType = String(raw.value_type ?? '').trim().toLowerCase();
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((o) => {
      const value = clean(typeof o === 'string' ? o : o?.value, 200);
      if (!value) return null;
      return { value, description: clean(typeof o === 'string' ? null : o?.description, 500) };
    })
    .filter(Boolean)
    .slice(0, 200);
  if (!PARAMETER_VALUE_TYPES.includes(valueType)) {
    valueType = options.length > 0 ? 'enum' : 'text';
  }
  return {
    component_id: component ? component.id : null,
    name,
    group_label: clean(raw.group),
    value_type: valueType,
    unit: clean(raw.unit, 40),
    value_min: clean(raw.value_min, 80),
    value_max: clean(raw.value_max, 80),
    default_value: clean(raw.default ?? raw.default_value, 200),
    description: clean(raw.description, 2000),
    options,
  };
}

// Every parameter of a module, with its options, keyed for the fill test.
async function existingParameters(db, moduleId) {
  const { ModuleParameter, ModuleParameterOption } = db.models;
  const rows = await ModuleParameter.findAll({
    where: { module_id: moduleId },
    order: [['id', 'ASC']],
  });
  const options =
    rows.length === 0
      ? []
      : await ModuleParameterOption.findAll({ where: { parameter_id: rows.map((r) => r.id) } });
  const counts = new Map();
  for (const o of options) counts.set(o.parameter_id, (counts.get(o.parameter_id) ?? 0) + 1);
  return { rows, counts };
}

// Ask the backend for the module's menu parameters and store what is missing.
// Returns { asked, created, options } — asked is what the model answered
// with, created what was new, options how many option rows were filled into
// parameters that had none.
export async function findParametersForModule(db, backend, module, manualPaths) {
  const { ModuleComponent, ModuleParameter, ModuleParameterOption } = db.models;
  const components = await ModuleComponent.findAll({
    where: { module_id: module.id },
    attributes: ['id', 'name', 'type'],
    order: [['id', 'ASC']],
  });
  const componentByName = new Map(
    components.map((c) => [String(c.name ?? '').trim().toLowerCase(), c])
  );

  const paths = Array.isArray(manualPaths) ? manualPaths : [manualPaths];
  const prompt = PARAMETERS_TEMPLATE(
    module.manufacturer,
    module.name,
    components.map((c) => ({ name: c.name, type: c.type }))
  );
  const response =
    paths.length > 1
      ? await backend.analyzeDocuments(prompt, paths)
      : await backend.analyzeDocument(prompt, paths[0]);
  const parsed = extractJsonObject(response);
  const answered = (Array.isArray(parsed.parameters) ? parsed.parameters : [])
    .map((raw) => parseParameter(raw, componentByName))
    .filter(Boolean)
    .slice(0, 500);

  // Re-read at write time, so a hand-added parameter (or a second pass that
  // finished while this one was thinking) is not duplicated or overwritten.
  const { rows, counts } = await existingParameters(db, module.id);
  const byKey = new Map(rows.map((r) => [key(r.component_id, r.name), r]));
  let position = rows.reduce((max, r) => Math.max(max, r.position ?? 0), 0);

  let created = 0;
  let filled = 0;
  for (const p of answered) {
    const found = byKey.get(key(p.component_id, p.name));
    if (found) {
      // A parameter that is already recorded keeps every field it has. The
      // one blank worth filling is an empty option list — the list is what a
      // user picks from, and a parameter added by hand rarely has one.
      if (p.options.length > 0 && (counts.get(found.id) ?? 0) === 0) {
        await ModuleParameterOption.bulkCreate(
          p.options.map((o, at) => ({
            parameter_id: found.id,
            value: o.value,
            description: o.description,
            position: at,
          }))
        );
        counts.set(found.id, p.options.length);
        filled += 1;
      }
      continue;
    }
    position += 1;
    const row = await ModuleParameter.create({
      module_id: module.id,
      component_id: p.component_id,
      name: p.name,
      group_label: p.group_label,
      value_type: p.value_type,
      unit: p.unit,
      value_min: p.value_min,
      value_max: p.value_max,
      default_value: p.default_value,
      description: p.description,
      position,
    });
    byKey.set(key(p.component_id, p.name), row);
    if (p.options.length > 0) {
      await ModuleParameterOption.bulkCreate(
        p.options.map((o, at) => ({
          parameter_id: row.id,
          value: o.value,
          description: o.description,
          position: at,
        }))
      );
      counts.set(row.id, p.options.length);
    }
    created += 1;
  }
  return { asked: answered.length, created, options: filled };
}
