// Manual analysis: submit a module's manual PDF to the LLM backend and store a
// summary plus a structured inventory of the module's components (jacks,
// buttons, toggles, ...) with voltage ranges and polarity, and the normalled
// connections between them (defaults that exist until a patch cable overrides
// them) so a patch's real signal path can be traced.

import { extractJsonObject } from './json.js';
import { refreshModuleLinks } from './moduleLinks.js';
import { normalizeHp } from './panelImage.js';

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

// The physical connector behind a jack when it is not an ordinary 3.5mm
// eurorack patch point. Signal still flows through these, so they keep their
// input/output type — but a cable may only join ports of the same kind.
export const PORT_KINDS = [
  'midi_din',
  'midi_trs',
  'usb',
  'spdif',
  'adat',
  'audio_quarter_inch',
  'audio_rca',
  'ethernet',
  'microphone',
  'speaker',
  'memory_card',
  'ribbon',
  'other',
];

// How a normalled connection is broken: by a cable arriving at the break
// jack, or by one leaving it (an output normalled to another output).
export const BREAK_MODES = ['cable_in', 'cable_out'];

// The attached set is a rendered product page, plus — when one was found — a
// second document about the same panel. Which kind of second document it is
// changes how it should be read: a retailer's listing is more product copy,
// while an open-source module's build document is assembly instructions whose
// panel information is reliable but scattered through wiring and BOM detail.
const PRODUCT_PAGE_JACK_GUIDANCE = ({ buildDoc = false } = {}) => `
${
  buildDoc
    ? `No user manual was attached. One PDF is a rendered PRODUCT PAGE — the
maker's or best available page for the module. The other is the module's
BUILD DOCUMENT: the assembly guide an open-source or DIY module publishes
instead of a manual. Read the build document for the panel it describes —
its jack and control labels, wiring and pinout tables, panel drawings and
PCB silkscreen are authoritative for what is on the front panel and which
way a signal runs. Ignore everything in it that is only about building the
module: the bill of materials, component values, resistor colour codes,
soldering order and calibration trimmers are not panel components, and a
part on the PCB is not a jack.`
    : `The attached PDFs are rendered PRODUCT PAGES, not a user manual. One is the
maker's (or best available) page and the others, when available, are
retailers' pages (Perfect Circuit, Detroit Modular, Midwest Modular).`
} Reconcile evidence from both and do not duplicate a physical
jack merely because both documents mention it. Product-page prose often names
features without giving a numbered panel tour. For JACKS ONLY, also inspect
every front-panel image, diagram, caption, specification and signal-flow
statement in either PDF and infer the most likely inventory and direction:
- Treat every visible 3.5mm patch socket as a jack even when the prose never
  enumerates it. Use its printed panel label as the name, keeping channel
  numbers and L/R suffixes that distinguish repeated sockets.
- Classify explicit IN/INPUT, CV, FM, V/OCT, GATE, TRIG, CLOCK, RESET and SYNC
  destinations as "input_jack"; classify OUT/OUTPUT, waveform, EOC/EOR and
  monitor/source sockets as "output_jack". Printed arrows and an INPUTS or
  OUTPUTS section heading override these naming conventions.
- Use the product copy's signal-flow language to resolve terse or ambiguous
  labels: a signal that controls, clocks, triggers or enters a function is an
  input; a signal the module generates, emits or makes available is an output.
  Use "bidirectional_jack" only when the page actually indicates either-way
  use, a passive mult, or an interchangeable connection.
- Do not invent a jack that is neither visible nor supported by the product
  copy. If a visible socket's direction truly cannot be resolved from its
  label, grouping, arrows or prose, omit it instead of assigning a random
  direction.

This extra visual inference applies only to input/output/bidirectional jacks.
For knobs, buttons, switches and every other non-jack component, keep the
normal rule below: list it only when the document describes it.
`;

// The re-analysis attaches retailer product pages BESIDE the manual proper.
// The manual stays authoritative; the pages fill in what it never names.
const RETAILER_PAGE_GUIDANCE = `
In addition to the user manual, one or more retailer PRODUCT PAGES (Perfect
Circuit, Detroit Modular, Midwest Modular), rendered to PDF, are attached.
The manual is the primary source: where the documents disagree, the manual
wins. Use the product pages to corroborate the panel inventory and to fill in
jacks and controls the manual never names — retailer copy often tours the
panel jack by jack. Do not duplicate a physical component merely because
several documents mention it.
`;

export const ANALYSIS_TEMPLATE = (
  manufacturer,
  name,
  { productPage = false, buildDoc = false, retailerPages = false } = {}
) => `You are a eurorack modular synthesizer expert. Analyze the attached ${productPage ? 'rendered product page' : 'user manual'}
for the module "${manufacturer} ${name}" and produce a structured description.
${productPage ? PRODUCT_PAGE_JACK_GUIDANCE({ buildDoc }) : retailerPages ? RETAILER_PAGE_GUIDANCE : ''}

Many manuals cover more than one panel — a host module together with its
expander, or a family of related modules. This description is for
"${manufacturer} ${name}" ONLY. Components that sit on a different panel are
named with the panel they belong to (see "panel" below) rather than being
listed as if they were part of this module.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "summary": "A thorough plain-text summary of what the module does and how it works.",
  "hp": 8,
  "components": [
    {
      "type": "input_jack",
      "name": "1V/OCT",
      "description": "Pitch CV input tracking one volt per octave.",
      "voltage_min": -2,
      "voltage_max": 5,
      "polarity": "bipolar",
      "group": null,
      "port_kind": null,
      "panel": null,
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
      "port_kind": null,
      "panel": null,
      "value_min": null,
      "value_max": null,
      "value_options": ["LP", "BP", "HP"]
    }
  ],
  "expanders": [
    {
      "name": "Atlx",
      "role": "expander",
      "description": "Adds dedicated waveform, filter and ring modulator outputs."
    }
  ],
  "normalizations": [
    {
      "target": "IN 2",
      "target_panel": null,
      "source": "IN 1",
      "source_panel": null,
      "source_label": null,
      "condition": null,
      "alternative_group": null,
      "break": null,
      "description": "Input 2 is normalled to input 1 until a cable is patched into input 2."
    },
    {
      "target": "PWM IN",
      "target_panel": null,
      "source": "SINE B",
      "source_panel": null,
      "source_label": null,
      "condition": { "control": "PWM SOURCE", "value": "left" },
      "alternative_group": "pwm source",
      "break": null,
      "description": "With the PWM SOURCE switch left, VCO B's sine is normalled to PWM IN."
    }
  ],
  "routes": [
    {
      "input": "IN 1",
      "input_panel": null,
      "output": "MIX OUT",
      "output_panel": null,
      "condition": null,
      "alternative_group": null,
      "description": "Channel 1 is summed into the mix output."
    },
    {
      "input": "VCF IN",
      "input_panel": null,
      "output": "LP",
      "output_panel": "Atlx",
      "condition": null,
      "alternative_group": null,
      "description": "The filter's lowpass output appears on the expander panel."
    }
  ],
  "switches": [
    {
      "name": "Switch section 1",
      "common": "O/I",
      "steps": ["I/O 1", "I/O 2", "I/O 3", "I/O 4"],
      "description": "The common jack connects to one of the four step jacks, advanced by the clock input."
    }
  ],
  "pairs": [
    {
      "a": "OUT L",
      "b": "OUT R",
      "kind": "stereo",
      "description": "The left and right halves of the stereo output."
    }
  ]
}

Rules:
- "hp" is how wide THIS module's front panel is in HP (1HP = 5.08mm), as a
  number. Manuals usually print it in the specifications ("Width: 8HP",
  "20 HP", "Panel width: 101.6mm" = 20HP). Use null if the manual does not
  state or draw it — a guess is worse than nothing here, and the width of an
  expander or a sibling module documented in the same manual is not this
  module's width.
- "type" must be one of: ${COMPONENT_TYPES.join(', ')}.
- List EVERY input jack, output jack, knob, slider, button, toggle, and switch
  described in the manual, plus any displays or other controls (type "other").
- "panel" is the module a component is physically on. Use null for
  "${manufacturer} ${name}" itself — which is almost always the answer. When
  the manual also documents an expander or a sibling module, give that panel's
  exact name as printed in the manual (e.g. "Atlx", "Algo", "Groove"). Do NOT
  leave "panel" null for a jack that is on another panel: a component listed
  without a panel is recorded as part of this module, and a host's jacks
  appearing on its expander (or the reverse) is a straightforward error.
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
  A mult's jacks are COPIES of one signal. Some modules instead have several
  bidirectional jacks that are INDEPENDENT of each other — a passive
  patch-extension or bridge panel where each jack carries its own signal to
  the matching jack elsewhere (e.g. a numbered 1-8 panel joined to a second
  panel by one cable). Those are not a mult: give every such jack its OWN
  distinct "group" (its number or label), so nothing suggests that patching
  one of them feeds the others.
- "port_kind" is the physical connector when a connection point is NOT an
  ordinary 3.5mm eurorack patch point: one of ${PORT_KINDS.join(', ')}.
  Use it for MIDI sockets ("midi_din" for 5-pin DIN, "midi_trs" for 3.5mm
  MIDI), USB sockets, S/PDIF and ADAT, 1/4" and RCA audio sockets, built-in
  microphones and speakers/headphone sockets, ethernet sockets, and memory
  card slots. Such a port still gets "input_jack" or "output_jack" as its
  type — signal flows through it — so a MIDI input is
  {"type": "input_jack", "port_kind": "midi_din"}. Use null for the module's
  ordinary patch points.
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
- In each normalization, "target" is the exact "name" of the jack that
  receives the normalled signal (usually an input). "source" is the exact
  "name" of the component (input or output jack) the signal comes from; when
  the source is an internal signal with no panel jack, use null for "source"
  and name the signal in "source_label" (e.g. "internal oscillator"). Use []
  if the manual describes no normalled connections.
- "break" says what cancels a normalled connection, for the cases where it is
  NOT simply "a cable patched into the target". Leave it null for the normal
  case. When a manual says an OUTPUT is normalled to another output — "the L
  output is normalled to the R output, so patching a single cable from R gives
  a mono sum" — the default is cancelled by patching a cable OUT of the other
  jack, so give {"jack": "<exact name>", "on": "cable_out"}. "on" is
  ${BREAK_MODES.join(' or ')}.
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
- "condition" appears on both normalizations and routes, and records that the
  path only exists in one setting of a control: a panel switch, a jumper, a
  stepped knob, a selected mode or algorithm. Give
  {"control": "<exact component name>", "value": "<exact position label>"},
  where the value is one of that control's "value_options". Use null when the
  path is always present.
  Examples of paths that MUST carry a condition:
    - a switch that chooses WHICH signal is normalled to an input ("with the
      switch left, the sine is normalled to PWM IN; with it right, the
      envelope is");
    - a switch that chooses WHERE a signal is inserted in the chain (mixed
      before the filter, or after it at the VCA);
    - a mix switch that turns an output from a channel pass-through into a
      mix of several channels;
    - a jumper or firmware/algorithm setting that connects one block to
      another.
- "alternative_group" ties together the paths that are alternatives to each
  other — the two positions of one switch feeding the same input, the several
  algorithms of one mode control. Use the same short label on every path of
  the set (e.g. "pwm source"), and null when a path is not one of a set. Paths
  in a group are never simultaneous: exactly one of them is live, which is
  what distinguishes selecting a signal from mixing several together.
- Every jack named in "normalizations", "routes", "switches" and "pairs" is
  one of the components above, given by its exact "name". A path may run
  BETWEEN PANELS — a host's filter appearing at an output on its expander is
  the common case — so "routes" take "input_panel"/"output_panel" and
  "normalizations" take "target_panel"/"source_panel", following the same rule
  as a component's "panel": null for this module, the other panel's name
  otherwise. Switch sections and pairs are always within one panel.
- "expanders" lists the other panels the manual presents as part of this
  instrument: an expander that adds jacks to this module ("role": "expander"),
  or, when the manual is really the host's and this module IS the expander,
  the host it attaches to ("role": "host"). Give the panel's name as printed.
  These are modules joined by a ribbon cable behind the panel, not modules
  merely mentioned as working well together — use [] when the manual
  describes no expander.
- "pairs" lists jacks that are the two halves of ONE signal — a stereo L/R
  output or input pair, most commonly. "a" and "b" are exact component
  "name"s and "kind" is usually "stereo". Do not pair jacks that merely sit
  next to each other or carry related-but-separate signals (an oscillator's
  saw and square outputs are not a pair). Use [] when the module has none.
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

// Analyze one module's manual and persist summary + components +
// normalizations.
export async function analyzeManualForModule(
  db,
  backend,
  module,
  manualPaths,
  { productPage = false, buildDoc = false, retailerPages = false } = {}
) {
  const paths = Array.isArray(manualPaths) ? manualPaths : [manualPaths];
  const prompt = ANALYSIS_TEMPLATE(module.manufacturer, module.name, {
    productPage,
    buildDoc,
    retailerPages,
  });
  const response =
    paths.length > 1
      ? await backend.analyzeDocuments(prompt, paths)
      : await backend.analyzeDocument(prompt, paths[0]);
  const parsed = extractJsonObject(response);
  const summary = String(parsed.summary || '').trim();
  // The panel width, where the manual states it. This is the module's own
  // property rather than the panel drawing's, so it is written to the module
  // record; a manual that states none leaves whatever is already recorded.
  const hp = normalizeHp(parsed.hp);
  const parsedComponents = normalizeComponents(parsed.components);
  const switches = normalizeSwitches(parsed.switches);
  const pairs = normalizePairs(parsed.pairs);
  const expanders = normalizeExpanders(parsed.expanders);
  if (!summary && parsedComponents.length === 0) {
    throw new Error('LLM analysis returned neither a summary nor components');
  }

  // One manual often covers a host and its expander. Only this module's own
  // panel becomes its component inventory; a signal path that runs to the
  // other panel is kept by name and resolved once both panels are analyzed
  // and linked.
  const { own: components, panelsUsable } = splitByPanel(parsedComponents, module);
  const isOwnPanel = (panel) => !panelsUsable || panelNamesModule(panel, module);
  const crossPanel = [];
  const normalizations = normalizeNormalizations(parsed.normalizations).filter((n) => {
    if (isOwnPanel(n.target_panel) && isOwnPanel(n.source_panel)) return true;
    crossPanel.push({ kind: 'normalization', payload: n });
    return false;
  });
  const routes = normalizeRoutes(parsed.routes).filter((r) => {
    if (isOwnPanel(r.input_panel) && isOwnPanel(r.output_panel)) return true;
    crossPanel.push({ kind: 'route', payload: r });
    return false;
  });
  const hints = [
    ...crossPanel,
    ...expanders.map((payload) => ({ kind: 'expander', payload })),
  ];

  const {
    Module,
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentValue,
    ComponentPair,
    ModulePathHint,
  } = db.models;
  // Replacing the component inventory and marking the analysis complete is
  // one atomic step — a failure mid-way must not leave the module stripped of
  // its previous components.
  let resolved = [];
  let resolvedRoutes = [];
  let resolvedSwitches = [];
  let resolvedPairs = [];
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
    await ModulePathHint.destroy({ where: { module_id: module.id }, transaction });
    if (hints.length > 0) {
      await ModulePathHint.bulkCreate(
        hints.map((h) => ({
          module_id: module.id,
          kind: h.kind,
          payload: JSON.stringify(h.payload),
        })),
        { transaction }
      );
    }
    await ComponentPair.destroy({ where: { module_id: module.id }, transaction });
    await ComponentRoute.destroy({ where: { module_id: module.id }, transaction });
    await ComponentNormalization.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.bulkCreate(
      // values and panel are not columns: values become component_values rows
      // once the components have ids, and panel has already done its job.
      components.map(({ values, panel, ...c }) => ({ ...c, module_id: module.id })),
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
    resolvedPairs = resolvePairs(pairs, created);
    if (resolvedPairs.length > 0) {
      await ComponentPair.bulkCreate(
        resolvedPairs.map((p) => ({ ...p, module_id: module.id })),
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
      { summary, analysis_status: 'complete', ...(hp === null ? {} : { hp }) },
      { where: { id: module.id }, transaction }
    );
  });
  // Anything the manual described about another panel — a signal path that
  // crosses to it, or the panel's existence — is acted on now that the
  // analysis is committed: link the two module records if both exist, and
  // materialize every path that has become resolvable (in either direction,
  // since this module may be the panel another one was waiting for).
  const links = await refreshModuleLinks(db, module);

  return {
    summary,
    hp,
    components,
    normalizations: resolved,
    routes: resolvedRoutes,
    switches: resolvedSwitches,
    pairs: resolvedPairs,
    hints,
    links,
  };
}
