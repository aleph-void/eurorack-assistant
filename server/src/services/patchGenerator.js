// Having the model build a patch.
//
// A patch is normally made one cable at a time by the person at the case.
// This is the other way in: the user names a rack or a system, how many
// cables they are willing to plug, and — optionally — what the patch should
// be ("a slow evolving drone", "techno kick and acid line"), and the
// `generate_patch` job asks the model to wire it up.
//
// What the model gets is an INVENTORY: every instance in the patch's snapshot
// with its jacks, controls and menu settings, each carrying the id it is
// addressed by, plus the normalled connections that exist before any cable
// is plugged. What it gives back is a JSON object of cables and settings that
// name those ids. NOTHING IT SAYS IS TRUSTED: every cable is resolved onto
// the patch and put through the SAME `cableProblem()` every hand-plugged
// cable goes through, in the order the model ranked them, and the first
// `max_cables` legal ones are what gets written. A setting is checked
// against the control's recorded values the same way. The answer is
// therefore never more than a person could have plugged themselves.
//
// The pieces that need no database — the inventory text, the prompt, the
// parse — are pure functions, tested without one (like patchDocument.js).

import { extractJsonObject } from './json.js';
import { loadPatchDetail } from './patchDetail.js';
import { normalizationSummary } from './ask.js';
import {
  cableProblem,
  resolveEndpoint,
} from '../routes/patches/helpers.js';

// How many cables a generated patch is allowed when the request does not
// say, and the most it may ever ask for: a patch of two hundred cables is a
// studio's worth of string, and the model has to rank every one.
export const DEFAULT_MAX_CABLES = 12;
export const MAX_GENERATED_CABLES = 200;
// The brief is a sentence or a paragraph, not a manual.
export const MAX_BRIEF_CHARS = 2000;
// How much of the answer is kept beyond the cables.
export const MAX_SETTINGS = 200;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_NOTE_CHARS = 300;
export const MAX_VALUE_CHARS = 200;
// How much of a module's summary and a component's description is worth a
// place in the inventory: enough to say what the thing is for.
const SUMMARY_CHARS = 400;
const DESCRIPTION_CHARS = 160;

// The request's max_cables, checked: absent means the default, anything else
// has to be a whole number between 1 and the ceiling. Answers { value } or
// { error }.
export function readMaxCables(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_MAX_CABLES };
  const n = Number(raw);
  if (typeof raw === 'boolean' || !Number.isInteger(n) || n < 1 || n > MAX_GENERATED_CABLES) {
    return {
      error: `max_cables must be a whole number between 1 and ${MAX_GENERATED_CABLES}`,
    };
  }
  return { value: n };
}

const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const instanceLabel = (pm) => {
  const base = `${pm.manufacturer ?? ''} ${pm.module_name ?? ''}`.trim() || 'unnamed module';
  const numbered = pm.instance > 1 ? `${base} #${pm.instance}` : base;
  return pm.label ? `${numbered} (${pm.label})` : numbered;
};

const JACK_TYPES = new Set(['input_jack', 'output_jack', 'bidirectional_jack']);

const jackRole = (component) => {
  if (component.type === 'output_jack') return 'output';
  if (component.type === 'input_jack') return 'input';
  return 'mult (takes a cable in or sends one out)';
};

// The voltage a jack carries, when the analysis recorded it.
const voltageText = (c) => {
  const parts = [];
  if (c.voltage_min !== null && c.voltage_min !== undefined && c.voltage_max !== null && c.voltage_max !== undefined) {
    parts.push(`${c.voltage_min} to ${c.voltage_max} V`);
  }
  if (c.polarity) parts.push(c.polarity);
  return parts.length ? ` [${parts.join(', ')}]` : '';
};

// What a control can be set to, from its recorded values: the enum positions
// or the min/max range.
const valuesText = (values = []) => {
  const enums = values.filter((v) => v.type === 'enum').map((v) => v.value);
  if (enums.length > 0) return ` — positions: ${enums.join(' | ')}`;
  const min = values.find((v) => v.type === 'min')?.value;
  const max = values.find((v) => v.type === 'max')?.value;
  if (min !== undefined && max !== undefined) return ` — range ${min} to ${max}`;
  if (min !== undefined) return ` — from ${min}`;
  if (max !== undefined) return ` — up to ${max}`;
  return '';
};

// The inventory the model designs from: one section per instance of the
// patch, naming every connection point, control and menu setting by the id
// the answer must use. `patch` is the loadPatchDetail json plus the record's
// own fields; `summaries` maps module_id to the analysis summary.
export function patchInventoryDocument(patch, { summaries = new Map(), normalizationLines = [] } = {}) {
  const modules = patch.modules ?? [];
  const modulesById = new Map(modules.map((m) => [m.id, m]));
  const spansRacks = new Set(modules.map((m) => m.rack_name).filter(Boolean)).size > 1;
  const lines = [];
  lines.push(`# ${patch.system_name ? 'System' : 'Rack'}: ${patch.system_name || patch.rack_name || patch.name}`);
  lines.push('', `${modules.length} module instance(s). Ids are what the answer refers to.`);

  for (const pm of modules) {
    const where = [];
    if (pm.external) where.push('gear outside the rack');
    if (spansRacks && pm.rack_name) where.push(`in rack "${pm.rack_name}"`);
    lines.push('', `## Instance ${pm.id}: ${instanceLabel(pm)}${where.length ? ` (${where.join(', ')})` : ''}`);
    const summary = pm.module_id ? summaries.get(pm.module_id) : null;
    if (summary) lines.push(clip(summary, SUMMARY_CHARS));
    const components = pm.components ?? [];
    const jacks = components.filter((c) => JACK_TYPES.has(c.type) && isPatchable(c));
    const controls = components.filter((c) => !JACK_TYPES.has(c.type));
    if (jacks.length > 0) {
      lines.push('Jacks:');
      for (const c of jacks) {
        const extras = [];
        if (c.port_kind && c.port_kind !== 'eurorack') extras.push(`${String(c.port_kind).replace(/_/g, ' ')} connection`);
        if (c.type === 'bidirectional_jack' && c.group_label) extras.push(`mult section "${c.group_label}"`);
        const description = c.description ? `: ${clip(c.description, DESCRIPTION_CHARS)}` : '';
        lines.push(
          `- jack ${c.id} "${c.name}" — ${jackRole(c)}${voltageText(c)}${extras.length ? ` (${extras.join(', ')})` : ''}${description}`
        );
      }
    }
    if (controls.length > 0) {
      lines.push('Controls:');
      for (const c of controls) {
        const description = c.description ? `: ${clip(c.description, DESCRIPTION_CHARS)}` : '';
        lines.push(`- control ${c.id} "${c.name}" — ${String(c.type).replace(/_/g, ' ')}${valuesText(c.values)}${description}`);
      }
    }
    const parameters = pm.parameters ?? [];
    if (parameters.length > 0) {
      lines.push('Menu settings (behind an encoder, not under a control of their own):');
      for (const p of parameters) {
        const owner = p.component_id && components.find((c) => c.id === p.component_id);
        const of = owner ? ` (of jack ${owner.id} "${owner.name}")` : '';
        const options = (p.options ?? []).map((o) => o.value).filter(Boolean);
        const range =
          options.length > 0
            ? ` — options: ${options.join(' | ')}`
            : p.value_min !== null && p.value_min !== undefined && p.value_max !== null && p.value_max !== undefined
              ? ` — range ${p.value_min} to ${p.value_max}${p.unit ? ` ${p.unit}` : ''}`
              : '';
        const description = p.description ? `: ${clip(p.description, DESCRIPTION_CHARS)}` : '';
        lines.push(`- parameter ${p.id} "${p.name}"${of}${range}${description}`);
      }
    }
  }

  const cables = patch.cables ?? [];
  if (cables.length > 0) {
    lines.push('', '## Cables already patched (keep them; do not repeat them)');
    for (const c of cables) {
      const from = modulesById.get(c.from_patch_module_id);
      const to = modulesById.get(c.to_patch_module_id);
      lines.push(
        `- ${from ? instanceLabel(from) : '?'} "${c.from_component_name}" (instance ${c.from_patch_module_id}, jack ${c.from_component_id}) → ` +
          `${to ? instanceLabel(to) : '?'} "${c.to_component_name}" (instance ${c.to_patch_module_id}, jack ${c.to_component_id})`
      );
    }
  }

  if (normalizationLines.length > 0) {
    lines.push('', '## Normalled connections (present with no cable plugged; a cable into the jack cancels it)');
    lines.push(...normalizationLines);
  }
  return lines.join('\n');
}

// A connector a cable cannot reach: an expansion header behind the panel, a
// USB socket, a memory card slot. The same rule the diagram and the cable
// pickers apply (client/src/panelLayout.js isPatchPoint).
function isPatchable(component) {
  return !['ribbon', 'usb', 'memory_card'].includes(component.port_kind ?? '');
}

export const GENERATE_TEMPLATE = (inventory, { maxCables, brief = '', existingCables = 0 }) => {
  const room = Math.max(0, maxCables - existingCables);
  const goal = brief
    ? `The user's brief for this patch:\n\n${brief}\n\nDesign the patch to that brief as closely as the hardware allows.`
    : 'No brief was given: design a complete, playable patch that shows off what this system does best — a sound source shaped and modulated on its way to wherever audio leaves the system.';
  return `You are a eurorack modular synthesizer expert designing a patch for a user's own system.
Below is every module instance in it, with the id of every jack, control and menu setting.

${goal}

You may add AT MOST ${room} new patch cable(s)${existingCables > 0 ? ` (${existingCables} are already plugged and count towards the user's limit of ${maxCables})` : ''}. Fewer is fine when fewer does the job; never more.

Rules — a cable that breaks one is thrown away, so respect them:
- A cable runs FROM an output jack (or a mult jack) TO an input jack (or a mult jack). Never output to output, never input to input.
- Each input takes at most ONE cable. An output may feed several inputs.
- Only join jacks of the same kind of connection: a MIDI or USB socket and a 3.5 mm patch point never share a cable, and a jack that is "gear outside the rack" is patched like any other.
- Use ONLY the instance, jack, control and parameter ids listed below. Never invent a module, a jack or an id, and never patch a jack to another jack of the same mult section.
- Account for the normalled connections: a default that already does what the patch needs costs no cable, and a cable into a normalled input cancels its default.
- Prefer a patch that can be heard: a source, what shapes it, what modulates it, and the module or gear that carries audio out. Use more of the system as the cable budget allows, and prefer the musically interesting connection over the obvious one when the brief calls for it.
- Dial in the controls and menu settings the patch depends on (a VCA that must be open, a filter cutoff, a clock division), using only the positions, ranges and options listed. Leave the rest alone.
- Give each cable a short note saying what it is for, and describe the whole patch in two or three sentences a player can follow.

Respond with ONLY a JSON object of this shape (no prose around it):
{
  "description": "what this patch does and how to play it",
  "cables": [
    { "from_module": <instance id>, "from_jack": <jack id>, "to_module": <instance id>, "to_jack": <jack id>, "note": "why" }
  ],
  "settings": [
    { "module": <instance id>, "component": <control id>, "value": "<position or number>" },
    { "module": <instance id>, "parameter": <parameter id>, "value": "<option or number>" }
  ]
}
List the cables in order of importance, the ones the patch cannot do without first: only the first ${room} legal ones are kept.

${inventory}
`;
};

const asId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// The model's answer as the app understands it: the cables and settings
// with usable ids, in the order given, capped in number and length;
// everything else is dropped rather than complained about. A cable may also
// arrive with its two ends nested ({ from: { module, jack }, to: {...} }),
// since that is how a model that has read the inventory sometimes writes it.
export function parseGeneratedPatch(text, { maxCables = MAX_GENERATED_CABLES } = {}) {
  const parsed = extractJsonObject(text);
  const end = (row, side) => {
    const nested = row?.[side] && typeof row[side] === 'object' ? row[side] : null;
    return {
      module: asId(row?.[`${side}_module`] ?? nested?.module ?? nested?.instance),
      jack: asId(row?.[`${side}_jack`] ?? nested?.jack ?? nested?.component),
    };
  };
  const cables = [];
  for (const row of Array.isArray(parsed.cables) ? parsed.cables : []) {
    const from = end(row, 'from');
    const to = end(row, 'to');
    if (!from.module || !from.jack || !to.module || !to.jack) continue;
    cables.push({
      from_module: from.module,
      from_jack: from.jack,
      to_module: to.module,
      to_jack: to.jack,
      note: clip(row?.note ?? row?.why ?? '', MAX_NOTE_CHARS) || null,
    });
    // The model was told the first `maxCables` legal ones are kept; a few
    // spares past that are worth having in case some are refused, a
    // thousand are not.
    if (cables.length >= maxCables * 2 + 10) break;
  }
  const settings = [];
  for (const row of Array.isArray(parsed.settings) ? parsed.settings : []) {
    const module = asId(row?.module ?? row?.instance);
    const parameter = asId(row?.parameter);
    const component = parameter ? null : asId(row?.component ?? row?.control);
    const value = clip(row?.value, MAX_VALUE_CHARS);
    if (!module || (!parameter && !component) || !value) continue;
    settings.push({ module, component, parameter, value });
    if (settings.length >= MAX_SETTINGS) break;
  }
  return {
    description: clip(parsed.description, MAX_DESCRIPTION_CHARS) || null,
    cables,
    settings,
  };
}

// Which of the user's patches a generate_patch job is still working on.
// The payload is TEXT, so the few live rows are read in JS.
export async function generatingPatchIds(db, userId) {
  const live = await db.models.Job.findAll({
    where: { type: 'generate_patch', user_id: userId, status: ['pending', 'running'] },
    attributes: ['payload'],
  });
  const ids = new Set();
  for (const job of live) {
    try {
      const id = Number(JSON.parse(job.payload || '{}').patch_id);
      if (id) ids.add(id);
    } catch {
      // not a payload this job type writes
    }
  }
  return ids;
}

// A setting the model proposed, checked against the patch: the control has
// to be one of the instance's, not a jack, and a control with recorded
// positions takes one of them (matched loosely, stored as recorded).
// Answers the row to write, or { error }.
async function resolveSetting(db, patch, setting, jacksByPatchModule) {
  const { ModuleParameter, ModuleComponent, PatchModule } = db.models;
  if (setting.parameter) {
    const pm = await PatchModule.findOne({
      where: { id: setting.module, patch_id: patch.id },
    });
    if (!pm || !pm.module_id) return { error: 'that module is not part of this patch' };
    const parameter = await ModuleParameter.findOne({
      where: { id: setting.parameter, module_id: pm.module_id },
    });
    if (!parameter) return { error: 'that parameter does not belong to this module' };
    let componentName = null;
    if (parameter.component_id) {
      const component = await ModuleComponent.findByPk(parameter.component_id);
      componentName = component?.name ?? null;
    }
    return {
      where: { patch_id: patch.id, patch_module_id: pm.id, parameter_id: parameter.id },
      fields: {
        component_id: parameter.component_id,
        component_name: componentName,
        parameter_name: parameter.name,
        value: setting.value,
      },
      label: `${instanceLabel(pm)} ${parameter.name} = ${setting.value}`,
    };
  }
  const target = await resolveEndpoint(db, patch, setting.module, setting.component);
  if (target.error) return { error: target.error };
  if (JACK_TYPES.has(target.component.type)) {
    return { error: 'jacks are patched with cables, not settings' };
  }
  // The recorded positions of the control, when it has any: a switch that
  // reads LP | BP | HP is not set to "warm".
  const recorded = (jacksByPatchModule.get(target.pm.id) ?? []).find(
    (c) => c.id === target.component.id
  );
  const enums = (recorded?.values ?? []).filter((v) => v.type === 'enum').map((v) => v.value);
  let value = setting.value;
  if (enums.length > 0) {
    const match = enums.find((v) => v.trim().toLowerCase() === value.trim().toLowerCase());
    if (!match) return { error: `'${target.component.name}' has no position '${value}'` };
    value = match;
  }
  return {
    where: {
      patch_id: patch.id,
      patch_module_id: target.pm.id,
      component_id: target.component.id,
      parameter_id: null,
    },
    fields: { component_name: target.component.name, parameter_name: null, value },
    label: `${instanceLabel(target.pm)} ${target.component.name} = ${value}`,
  };
}

// The whole job: read the patch, ask, keep what is legal, write it.
// Answers { cables, settings, refused } — how many of each were written and
// how many proposals the rules threw out.
export async function generatePatch(
  db,
  backend,
  patch,
  { maxCables = DEFAULT_MAX_CABLES, brief = '', log = () => {} } = {}
) {
  const { Module, ModuleComponent, ComponentNormalization, PatchCable, PatchSetting } = db.models;
  const { json, topology, liveIds } = await loadPatchDetail(db, patch, {
    includeRackLayout: false,
  });
  const existing = await PatchCable.findAll({ where: { patch_id: patch.id } });
  if (existing.length >= maxCables) {
    log(`the patch already has ${existing.length} cable(s), the limit asked for; nothing to add`);
    return { cables: 0, settings: 0, refused: 0 };
  }
  const liveModules = liveIds.size === 0 ? [] : await Module.findAll({ where: { id: [...liveIds] } });
  const summaries = new Map(liveModules.map((m) => [m.id, m.summary]).filter(([, s]) => s));
  const normalizationLines = await normalizationSummary(
    { ModuleComponent, ComponentNormalization },
    liveModules.map((m) => m.get({ plain: true }))
  );
  const inventory = patchInventoryDocument(
    { ...patch.get({ plain: true }), ...json },
    { summaries, normalizationLines }
  );
  const jackCount = json.modules.reduce(
    (n, pm) => n + pm.components.filter((c) => JACK_TYPES.has(c.type)).length,
    0
  );
  if (jackCount === 0) {
    const bare = new Error(
      'none of the modules in this patch has analyzed jacks yet — analyze their manuals first'
    );
    bare.permanent = true;
    throw bare;
  }
  log(
    `asking for a patch of at most ${maxCables} cable(s) across ${json.modules.length} module(s)` +
      (brief ? ` — brief: ${clip(brief, 120)}` : '')
  );
  const answer = await backend.completeText(
    GENERATE_TEMPLATE(inventory, { maxCables, brief, existingCables: existing.length })
  );
  const proposal = parseGeneratedPatch(answer, { maxCables });
  log(`the model proposed ${proposal.cables.length} cable(s) and ${proposal.settings.length} setting(s)`);

  // Every cable through the rules a hand-plugged one meets, in the order the
  // model ranked them, against the patch as it will be once the ones before
  // it are in.
  const kept = [];
  const rows = existing.map((c) => c.get({ plain: true }));
  let refused = 0;
  for (const proposed of proposal.cables) {
    if (rows.length >= maxCables) break;
    const from = await resolveEndpoint(db, patch, proposed.from_module, proposed.from_jack);
    const to = from.error
      ? from
      : await resolveEndpoint(db, patch, proposed.to_module, proposed.to_jack);
    const problem =
      from.error || to.error
        ? { error: from.error ? `from: ${from.error}` : `to: ${to.error}` }
        : await cableProblem(db, patch, from, to, rows);
    if (problem) {
      refused += 1;
      log(`refused a cable: ${problem.error}`);
      continue;
    }
    const row = {
      patch_id: patch.id,
      from_patch_module_id: from.pm.id,
      from_component_id: from.component.id,
      from_component_name: from.component.name,
      to_patch_module_id: to.pm.id,
      to_component_id: to.component.id,
      to_component_name: to.component.name,
      note: proposed.note,
      optional: false,
      stacked: false,
      alt_group: null,
    };
    rows.push(row);
    kept.push(row);
    log(
      `${instanceLabel(from.pm)} "${from.component.name}" → ${instanceLabel(to.pm)} "${to.component.name}"` +
        (proposed.note ? ` — ${proposed.note}` : '')
    );
  }
  if (kept.length === 0) {
    throw new Error(
      proposal.cables.length === 0
        ? 'the model proposed no cables'
        : `none of the ${proposal.cables.length} cable(s) the model proposed was legal`
    );
  }

  const settings = [];
  for (const proposed of proposal.settings) {
    const resolved = await resolveSetting(db, patch, proposed, topology.jacksByPatchModule);
    if (resolved.error) {
      log(`refused a setting: ${resolved.error}`);
      continue;
    }
    settings.push(resolved);
  }

  await db.sequelize.transaction(async (transaction) => {
    await PatchCable.bulkCreate(kept, { transaction });
    for (const setting of settings) {
      const found = await PatchSetting.findOne({ where: setting.where, transaction });
      if (found) await found.update(setting.fields, { transaction });
      else await PatchSetting.create({ ...setting.where, ...setting.fields }, { transaction });
      log(`set ${setting.label}`);
    }
    // The model's account of the patch stands as its description when the
    // user gave none — a generated patch nobody has explained yet.
    if (!patch.description && proposal.description) {
      await patch.update({ description: proposal.description }, { transaction });
    }
  });
  return { cables: kept.length, settings: settings.length, refused };
}
