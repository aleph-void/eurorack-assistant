// The words the analysis is allowed to use.
//
// The component types, port kinds and normalization break modes are one
// vocabulary shared three ways: the prompt tells the model to answer in it
// (services/manualPrompt.js), the server validates every answer against it
// (services/manualNormalize.js), and client/src/componentTypes.js mirrors it
// for the colours every picture of a panel is drawn in.

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
