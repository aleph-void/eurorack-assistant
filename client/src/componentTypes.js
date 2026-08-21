// Every kind of thing a module's front panel can hold, in one place: what the
// types are, what the pages call them, and the colour every picture draws
// them in.
//
// The list itself mirrors COMPONENT_TYPES in server/src/services/
// manualAnalyzer.js, which is the source of truth — the server validates
// against it. Anything the client offers that the server would refuse is a
// bug, so the two lists are kept in the same order.
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

export const TYPE_LABELS = {
  input_jack: 'Input jacks',
  output_jack: 'Output jacks',
  bidirectional_jack: 'Bidirectional jacks (mults)',
  knob: 'Knobs',
  slider: 'Sliders',
  button: 'Buttons',
  toggle: 'Toggles',
  switch: 'Switches',
  display: 'Displays',
  other: 'Other',
};

// 'input_jack' → 'input jack', for a sentence rather than a heading.
export const typeLabel = (type) => String(type ?? 'other').replace(/_/g, ' ');

// One colour per component type, drawn identically everywhere a panel is:
// the module page's front-panel picture, the rack organizer's rows, and the
// patch diagram. A marker's colour is the ONLY thing that says what a hole is
// when there is no room for its name, so the ten are picked to stay apart
// from each other on a photograph of a panel of any colour — a ring of colour
// over a dark halo (or a light one, on a black panel).
//
// The three jack colours came first and are what the patch diagram's
// instructions name: violet runs out, green runs in, yellow is a jack the
// patch decides the direction of (a mult, one end of a dual's bridged wire).
// The controls follow round the wheel from there.
export const COMPONENT_COLORS = {
  output_jack: '#a78bfa',
  input_jack: '#4ade80',
  bidirectional_jack: '#facc15',
  knob: '#fb923c',
  slider: '#38bdf8',
  button: '#f472b6',
  toggle: '#2dd4bf',
  switch: '#f87171',
  display: '#a3e635',
  other: '#a1a1aa',
};

// The colour for a type, including a type this build has never heard of: an
// older client drawing a panel analyzed by a newer server still draws every
// marker, in the neutral that 'other' uses.
export const componentColor = (type) => COMPONENT_COLORS[type] ?? COMPONENT_COLORS.other;

// The types actually present in a set of components or panel placements, in
// the canonical order, so a legend lists what is on the picture rather than
// the whole catalogue.
export function typesPresent(items) {
  const seen = new Set((items ?? []).map((item) => item?.type).filter(Boolean));
  return COMPONENT_TYPES.filter((type) => seen.has(type));
}
