// Having the model build a patch.
//
// A patch is normally made one cable at a time by the person at the case.
// This is the other way in: the user names a rack or a system, how many
// cables they are willing to plug, and — optionally — what the patch should
// be ("a slow evolving drone", "techno kick and acid line"), and the
// `generate_patch` job asks the model to wire it up. The same job runs AGAIN
// on a patch that exists (`POST /api/patches/:id/generate`) with a new brief
// and a new budget, which is how a generated patch is refined by hand-and-
// model in turns.
//
// What the model gets is an INVENTORY: every instance in the patch's snapshot
// with its jacks, controls and menu settings, each carrying the id it is
// addressed by, the cables and settings already there, and the normalled
// connections that exist before any cable is plugged. What it gives back is
// a JSON object of cables and settings that name those ids. NOTHING IT SAYS
// IS TRUSTED: every cable is resolved onto the patch and put through the
// SAME `cableProblem()` every hand-plugged cable goes through, in the order
// the model ranked them, and the first `max_cables` legal ones are what gets
// written. A setting is checked against the control's recorded values the
// same way. The answer is therefore never more than a person could have
// plugged themselves.
//
// A PATCH IS NOT MADE IN ONE ANSWER, so the job is a conversation in ROUNDS:
//
//   1. the cable rounds — the first asks for the patch; each one after it
//      shows the model what was kept (by cable id, so it may unplug its own
//      again), what was refused and why, and how much of the budget is left,
//      and asks it to fill the holes or say it is done. A round only follows
//      a round that had refusals with budget still to spend: a model that
//      used its allowance, or chose fewer, is finished.
//   2. the settings review — with the patch as it now stands, TRACED (the
//      same document a question about the patch reads: cables, settings,
//      surviving normals and the signal flow), the model goes through every
//      module the patch uses and dials in the controls and menu settings the
//      patch depends on. A patch is more than its connections: a VCA left
//      closed, a clock at the wrong division or an attenuverter at zero is a
//      patch that does not work, whatever the cables say.
//
// Each round is written as it lands, so the patch fills in while the job
// runs and an attempt that dies mid-way leaves a patch the next one carries
// on from (cables already there count towards the budget).
//
// The pieces that need no database — the inventory text, the prompts, the
// parse — are pure functions, tested without one (like patchDocument.js).

import { extractJsonObject } from './json.js';
import { loadPatchDetail } from './patchDetail.js';
import { patchTextDocument } from './patchDocument.js';
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
// How many times the model is asked for cables before the job settles for
// what it has, and the settings review that always follows.
export const MAX_CABLE_ROUNDS = 3;
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

  const settings = patch.settings ?? [];
  if (settings.length > 0) {
    lines.push('', '## Settings already dialed in (answer a new value only to change one)');
    for (const st of settings) {
      const pm = modulesById.get(st.patch_module_id);
      const what = st.parameter_id
        ? `parameter ${st.parameter_id} "${st.parameter_name}"${st.component_name ? ` (of "${st.component_name}")` : ''}`
        : `control ${st.component_id} "${st.component_name}"`;
      lines.push(`- ${pm ? instanceLabel(pm) : '?'} (instance ${st.patch_module_id}) ${what} = ${st.value}`);
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

const CABLE_RULES = `Rules — a cable that breaks one is thrown away, so respect them:
- A cable runs FROM an output jack (or a mult jack) TO an input jack (or a mult jack). Never output to output, never input to input.
- Each input takes at most ONE cable. An output may feed several inputs.
- Only join jacks of the same kind of connection: a MIDI or USB socket and a 3.5 mm patch point never share a cable, and a jack that is "gear outside the rack" is patched like any other.
- Use ONLY the instance, jack, control and parameter ids listed in the inventory. Never invent a module, a jack or an id, and never patch a jack to another jack of the same mult section.
- Account for the normalled connections: a default that already does what the patch needs costs no cable, and a cable into a normalled input cancels its default.`;

const ANSWER_SHAPE = `Respond with ONLY a JSON object of this shape (no prose around it):
{
  "description": "what this patch does and how to play it",
  "cables": [
    { "from_module": <instance id>, "from_jack": <jack id>, "to_module": <instance id>, "to_jack": <jack id>, "note": "why" }
  ],
  "settings": [
    { "module": <instance id>, "component": <control id>, "value": "<position or number>" },
    { "module": <instance id>, "parameter": <parameter id>, "value": "<option or number>" }
  ]
}`;

const goalText = (brief) =>
  brief
    ? `The user's brief for this patch:\n\n${brief}\n\nDesign the patch to that brief as closely as the hardware allows.`
    : 'No brief was given: design a complete, playable patch that shows off what this system does best — a sound source shaped and modulated on its way to wherever audio leaves the system.';

// The first round: the patch, from the inventory.
export const GENERATE_TEMPLATE = (inventory, { maxCables, brief = '', existingCables = 0 }) => {
  const room = Math.max(0, maxCables - existingCables);
  return `You are a eurorack modular synthesizer expert designing a patch for a user's own system.
Below is every module instance in it, with the id of every jack, control and menu setting.

${goalText(brief)}

You may add AT MOST ${room} new patch cable(s)${existingCables > 0 ? ` (${existingCables} are already plugged and count towards the user's limit of ${maxCables})` : ''}. Fewer is fine when fewer does the job; never more.

${CABLE_RULES}
- Prefer a patch that can be heard: a source, what shapes it, what modulates it, and the module or gear that carries audio out. Use more of the system as the cable budget allows, and prefer the musically interesting connection over the obvious one when the brief calls for it.
- Dial in the controls and menu settings the patch depends on (a VCA that must be open, a filter cutoff, a clock division), using only the positions, ranges and options listed. You will be asked to review every setting once the cables are in, so concentrate on the cables here.
- Give each cable a short note saying what it is for, and describe the whole patch in two or three sentences a player can follow.

${ANSWER_SHAPE}
List the cables in order of importance, the ones the patch cannot do without first: only the first ${room} legal ones are kept.

${inventory}
`;
};

// A round after the first: what landed, what did not and why, and how much
// budget is left. The model fills the holes, re-routes around a refusal (it
// may unplug a cable IT plugged in this job, by id), or says it is done.
export const REFINE_TEMPLATE = (
  inventory,
  { maxCables, brief = '', kept = [], refused = [], room = 0, round = 2 }
) => `You are a eurorack modular synthesizer expert designing a patch for a user's own system, and this is round ${round} of building it.

${goalText(brief)}

The cables you proposed were checked against the hardware. These were plugged (each with the cable id it now has):
${kept.length > 0 ? kept.map((c) => `- cable ${c.id}: ${c.text}`).join('\n') : '- none'}

These were REFUSED, for the reason given:
${refused.length > 0 ? refused.map((r) => `- ${r.text}: ${r.reason}`).join('\n') : '- none'}

You may add AT MOST ${room} more cable(s) (the user's limit is ${maxCables} in all). Fill what the refusals left undone — re-routing where a jack turned out to be taken or wrong — or, if the patch is complete as it stands, answer {"done": true}. To take back a cable you plugged in an earlier round, list its id under "unplug"; unplugging frees its input and its place in the budget.

${CABLE_RULES}

${ANSWER_SHAPE}
Two extra keys are allowed: "unplug": [<cable id>, ...] and "done": true.

${inventory}
`;

// The last word: the patch as it stands, traced, and every control and menu
// setting it depends on dialed in.
export const SETTINGS_TEMPLATE = (inventory, patchDocument, { brief = '' } = {}) => `You are a eurorack modular synthesizer expert. The cables of a patch on a user's own system are plugged; what remains is to set it up so it works and sounds as intended. A patch is more than its connections: a VCA left closed, a clock at the wrong division, a waveform not selected or a modulation attenuator at zero is a patch that makes no sound, whatever the cables say.

${brief ? `The user's brief for this patch:\n\n${brief}\n` : ''}
Below is the patch as it now stands — its cables, the settings already recorded, the normalled connections that survive and the signal flow those add up to — followed by the inventory of every module with the id of every control and menu setting.

Go through EVERY module the patch uses and dial in each control and menu setting that matters for this patch: levels and VCA openings, envelope shapes, filter cutoff and resonance, oscillator ranges and waveforms, modulation depths and attenuverters, clock divisions and menu selections, mixer and output levels. Use only the positions, ranges and options listed in the inventory. A control that does not matter here is left alone. Where a setting is already recorded and right, do not repeat it; answer a new value only to change one.

Respond with ONLY a JSON object of this shape (no prose around it):
{
  "description": "what this patch does and how to play it, in two or three sentences",
  "settings": [
    { "module": <instance id>, "component": <control id>, "value": "<position or number>" },
    { "module": <instance id>, "parameter": <parameter id>, "value": "<option or number>" }
  ]
}

--- The patch as it stands ---

${patchDocument}

--- Inventory ---

${inventory}
`;

const asId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// The model's answer as the app understands it: the cables and settings
// with usable ids, in the order given, capped in number and length, the
// cable ids it wants unplugged and whether it says it is done; everything
// else is dropped rather than complained about. A cable may also arrive with
// its two ends nested ({ from: { module, jack }, to: {...} }), since that is
// how a model that has read the inventory sometimes writes it.
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
  const unplug = [];
  for (const raw of Array.isArray(parsed.unplug) ? parsed.unplug : []) {
    const id = asId(typeof raw === 'object' && raw !== null ? raw.cable ?? raw.id : raw);
    if (id && !unplug.includes(id)) unplug.push(id);
    if (unplug.length >= MAX_GENERATED_CABLES) break;
  }
  return {
    description: clip(parsed.description, MAX_DESCRIPTION_CHARS) || null,
    cables,
    settings,
    unplug,
    done: parsed.done === true,
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

// The patch as the model needs to see it: the loadPatchDetail json with the
// module summaries and the normalled connections beside it.
async function readPatch(db, patch) {
  const { Module, ModuleComponent, ComponentNormalization } = db.models;
  const { json, topology, liveIds } = await loadPatchDetail(db, patch, {
    includeRackLayout: false,
  });
  const liveModules =
    liveIds.size === 0 ? [] : await Module.findAll({ where: { id: [...liveIds] } });
  const summaries = new Map(liveModules.map((m) => [m.id, m.summary]).filter(([, s]) => s));
  const normalizationLines = await normalizationSummary(
    { ModuleComponent, ComponentNormalization },
    liveModules.map((m) => m.get({ plain: true }))
  );
  const plain = { ...patch.get({ plain: true }), ...json };
  return {
    json,
    topology,
    inventory: patchInventoryDocument(plain, { summaries, normalizationLines }),
    document: patchTextDocument(plain),
  };
}

// Every cable of one round through the rules a hand-plugged one meets, in
// the order the model ranked them, against the patch as it will be once the
// ones before it are in. Answers what to write and what was refused.
async function judgeCables(db, patch, proposed, rows, maxCables, log) {
  const kept = [];
  const refused = [];
  for (const p of proposed) {
    if (rows.length >= maxCables) break;
    const from = await resolveEndpoint(db, patch, p.from_module, p.from_jack);
    const to = from.error ? from : await resolveEndpoint(db, patch, p.to_module, p.to_jack);
    const problem =
      from.error || to.error
        ? { error: from.error ? `from: ${from.error}` : `to: ${to.error}` }
        : await cableProblem(db, patch, from, to, rows);
    if (problem) {
      refused.push({
        text: `instance ${p.from_module} jack ${p.from_jack} → instance ${p.to_module} jack ${p.to_jack}`,
        reason: problem.error,
      });
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
      note: p.note,
      optional: false,
      stacked: false,
      alt_group: null,
    };
    rows.push(row);
    kept.push({
      row,
      text:
        `${instanceLabel(from.pm)} "${from.component.name}" (instance ${from.pm.id}, jack ${from.component.id}) → ` +
        `${instanceLabel(to.pm)} "${to.component.name}" (instance ${to.pm.id}, jack ${to.component.id})`,
    });
    log(
      `${instanceLabel(from.pm)} "${from.component.name}" → ${instanceLabel(to.pm)} "${to.component.name}"` +
        (p.note ? ` — ${p.note}` : '')
    );
  }
  return { kept, refused };
}

// The settings of one answer, checked and written (a value already recorded
// is replaced). Answers how many were written.
async function writeSettings(db, patch, proposed, jacksByPatchModule, log, transaction) {
  const { PatchSetting } = db.models;
  let written = 0;
  for (const p of proposed) {
    const resolved = await resolveSetting(db, patch, p, jacksByPatchModule);
    if (resolved.error) {
      log(`refused a setting: ${resolved.error}`);
      continue;
    }
    const found = await PatchSetting.findOne({ where: resolved.where, transaction });
    if (found) await found.update(resolved.fields, { transaction });
    else await PatchSetting.create({ ...resolved.where, ...resolved.fields }, { transaction });
    log(`set ${resolved.label}`);
    written += 1;
  }
  return written;
}

// The whole job: read the patch, ask in rounds, keep what is legal, write it
// as it lands, then review the settings over the traced result.
// Answers { cables, settings, refused, rounds } — how many cables and
// settings were written, how many proposals the rules threw out, and how
// many times the model was asked for cables.
export async function generatePatch(
  db,
  backend,
  patch,
  { maxCables = DEFAULT_MAX_CABLES, brief = '', log = () => {} } = {}
) {
  const { PatchCable } = db.models;
  let state = await readPatch(db, patch);
  const jackCount = state.json.modules.reduce(
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

  // The cables as the patch holds them, kept current round by round so the
  // rules judge each proposal against everything before it — and the ids of
  // the ones THIS job plugged, the only ones it may take back.
  const rows = (await PatchCable.findAll({ where: { patch_id: patch.id } })).map((c) =>
    c.get({ plain: true })
  );
  const before = rows.length;
  const mine = new Map();
  let description = null;
  let refusedTotal = 0;
  let settingsTotal = 0;
  let rounds = 0;
  let feedback = null;

  if (before >= maxCables) {
    log(
      `the patch already has ${before} cable(s), the limit asked for; reviewing its settings only`
    );
  } else {
    log(
      `asking for a patch of at most ${maxCables} cable(s) across ${state.json.modules.length} module(s)` +
        (brief ? ` — brief: ${clip(brief, 120)}` : '')
    );
  }

  while (before < maxCables && rounds < MAX_CABLE_ROUNDS) {
    rounds += 1;
    const room = maxCables - rows.length;
    if (room <= 0) break;
    const prompt =
      rounds === 1
        ? GENERATE_TEMPLATE(state.inventory, { maxCables, brief, existingCables: rows.length })
        : REFINE_TEMPLATE(state.inventory, { ...feedback, maxCables, brief, room, round: rounds });
    if (rounds > 1) log(`round ${rounds}: ${room} cable(s) of budget left after ${feedback.refused.length} refusal(s)`);
    const proposal = parseGeneratedPatch(await backend.completeText(prompt), { maxCables });
    if (proposal.description) description = proposal.description;
    if (proposal.done && proposal.cables.length === 0 && proposal.unplug.length === 0) {
      log(`round ${rounds}: the model says the patch is complete`);
      break;
    }
    log(
      `round ${rounds}: the model proposed ${proposal.cables.length} cable(s)` +
        (proposal.unplug.length ? `, takes back ${proposal.unplug.length}` : '') +
        ` and ${proposal.settings.length} setting(s)`
    );
    // A cable the model plugged earlier in this job may be taken back; the
    // user's own, and anything it never plugged, may not.
    const unplug = proposal.unplug.filter((id) => mine.has(id));
    for (const id of unplug) {
      const at = rows.findIndex((r) => r.id === id);
      if (at !== -1) rows.splice(at, 1);
      log(`unplugged cable ${id}: ${mine.get(id)}`);
      mine.delete(id);
    }
    const { kept, refused } = await judgeCables(db, patch, proposal.cables, rows, maxCables, log);
    refusedTotal += refused.length;
    if (kept.length === 0 && unplug.length === 0 && proposal.settings.length === 0) {
      feedback = { kept: [], refused };
      if (refused.length === 0) break;
      continue;
    }
    await db.sequelize.transaction(async (transaction) => {
      if (unplug.length > 0) {
        await PatchCable.destroy({ where: { patch_id: patch.id, id: unplug }, transaction });
      }
      for (const k of kept) {
        const created = await PatchCable.create(k.row, { transaction });
        k.row.id = created.id;
        mine.set(created.id, k.text);
      }
      settingsTotal += await writeSettings(
        db,
        patch,
        proposal.settings,
        state.topology.jacksByPatchModule,
        log,
        transaction
      );
    });
    feedback = { kept: kept.map((k) => ({ id: k.row.id, text: k.text })), refused };
    // Another round only fills holes a refusal left: a model that used its
    // allowance, or chose fewer than it, is finished.
    if (proposal.done || refused.length === 0) break;
  }
  if (rows.length === 0) {
    throw new Error(
      refusedTotal === 0
        ? 'the model proposed no cables'
        : `none of the ${refusedTotal} cable(s) the model proposed was legal`
    );
  }

  // The settings review, over the patch as it now stands and traced — the
  // same document a question about the patch reads.
  state = await readPatch(db, patch);
  log(`reviewing the settings of the patch as it stands (${rows.length} cable(s))`);
  const review = parseGeneratedPatch(
    await backend.completeText(SETTINGS_TEMPLATE(state.inventory, state.document, { brief }))
  );
  if (review.description) description = review.description;
  log(`the model proposed ${review.settings.length} setting(s)`);
  await db.sequelize.transaction(async (transaction) => {
    settingsTotal += await writeSettings(
      db,
      patch,
      review.settings,
      state.topology.jacksByPatchModule,
      log,
      transaction
    );
    // The model's account of the patch stands as its description when the
    // user gave none — a generated patch nobody has explained yet.
    if (!patch.description && description) {
      await patch.update({ description }, { transaction });
    }
  });
  return { cables: rows.length - before, settings: settingsTotal, refused: refusedTotal, rounds };
}
