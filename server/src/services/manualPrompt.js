// What the model is asked when a manual is analyzed.
//
// One prompt, assembled from the documents that were actually found: a
// manual on its own, or a rendered product page plus — where one turned up —
// a second document about the same panel, which is read differently
// depending on whether it is a retailer's listing or a build document.

import { BREAK_MODES, COMPONENT_TYPES, PORT_KINDS } from './manualVocabulary.js';

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
