// Module records the twelve module pages are tested against. Each page is its
// own view over the same `GET /api/modules/:id` payload, so the fixtures are
// shared rather than written out once per page.

export const mathsModule = {
  id: 1,
  manufacturer: 'Make Noise',
  name: 'Maths',
  manual_status: 'found',
  analysis_status: 'complete',
  summary: 'A dual function generator.',
  quantity: 3,
  racks: [
    { id: 1, name: 'main rack', quantity: 2 },
    { id: 2, name: 'travel case', quantity: 1 },
  ],
  manuals: [
    { id: 1, hash: 'a'.repeat(64), name: 'manual', original_name: 'Make_Noise_Maths_Manual.pdf', source: 'found', user_id: null, has_text: true, text_pages: 12 },
    { id: 2, hash: 'b'.repeat(64), name: 'my notes', original_name: 'my-notes.pdf', source: 'upload', user_id: 2, has_text: false, text_pages: null },
  ],
  components: [
    { id: 1, type: 'input_jack', name: 'Signal In', description: 'In', voltage_min: -10, voltage_max: 10, polarity: 'bipolar' },
    { id: 2, type: 'output_jack', name: 'EOR', description: 'Gate', voltage_min: 0, voltage_max: 10, polarity: 'unipolar' },
    { id: 3, type: 'knob', name: 'Rise', description: 'Rise time', voltage_min: null, voltage_max: null, polarity: null },
  ],
};

export const valuesModule = {
  id: 1,
  manufacturer: 'Make Noise',
  name: 'Maths',
  manual_status: 'found',
  analysis_status: 'complete',
  summary: 'x',
  quantity: 1,
  racks: [{ id: 1, name: 'main rack', quantity: 1 }],
  manuals: [],
  components: [
    { id: 3, type: 'knob', name: 'Rise', description: null, voltage_min: null, voltage_max: null, polarity: null,
      values: [
        { id: 1, type: 'min', value: '0' },
        { id: 2, type: 'max', value: '10' },
      ] },
    { id: 4, type: 'switch', name: 'Mode', description: null, voltage_min: null, voltage_max: null, polarity: null,
      values: [{ id: 3, type: 'enum', value: 'Cycle', description: 'loops' }] },
  ],
};

// Signal paths that are not simply "this jack to that jack": defaults that
// depend on a switch, connections that are not 3.5mm patch points, expander
// panels and stereo pairs.
export const conditionalModule = {
  id: 1,
  manufacturer: 'Intellijel',
  name: 'Atlantix',
  manual_status: 'found',
  analysis_status: 'complete',
  summary: 'x',
  quantity: 1,
  racks: [{ id: 1, name: 'main rack', quantity: 1 }],
  manuals: [],
  notes: [],
  components: [
    { id: 1, type: 'input_jack', name: 'PWM IN', values: [] },
    { id: 2, type: 'output_jack', name: 'SINE B', values: [] },
    { id: 3, type: 'output_jack', name: 'L', port_kind: null, values: [] },
    { id: 4, type: 'output_jack', name: 'R', values: [] },
    {
      id: 5,
      type: 'switch',
      name: 'PWM SOURCE',
      values: [
        { id: 9, type: 'enum', value: 'left' },
        { id: 10, type: 'enum', value: 'right' },
      ],
    },
    { id: 6, type: 'input_jack', name: 'MIDI IN', port_kind: 'midi_din', values: [] },
  ],
  normalizations: [
    {
      id: 41,
      target_component_id: 1,
      source_component_id: 2,
      source_label: null,
      kind: 'output',
      condition_component_id: 5,
      condition_value: 'left',
      alt_group: 'pwm source',
      break_component_id: null,
      break_on: 'cable_in',
      description: null,
    },
    {
      id: 42,
      target_component_id: 4,
      source_component_id: 3,
      source_label: null,
      kind: 'output',
      condition_component_id: null,
      condition_value: null,
      alt_group: null,
      break_component_id: 3,
      break_on: 'cable_out',
      description: 'Patching only R gives a mono sum.',
    },
  ],
  routes: [
    {
      id: 51,
      input_component_id: 1,
      output_component_id: 2,
      condition_component_id: 5,
      condition_value: 'right',
      alt_group: 'pwm source',
      description: null,
    },
  ],
  switches: [],
  pairs: [{ id: 61, a_component_id: 3, b_component_id: 4, kind: 'stereo', description: null }],
  expanders: [
    { id: 71, role: 'expander', module_id: 2, manufacturer: 'Intellijel', name: 'Atlx', description: null },
  ],
  expander_components: [{ id: 80, module_id: 2, type: 'output_jack', name: 'LP', port_kind: null }],
  expander_suggestions: [
    { name: 'Performer', role: 'expander', description: null, module_id: null },
  ],
};

// A dual module: two panels of one product joined by a link cable, whose
// jacks pair up one to one (Omnitone 7Path). Declared on the hardware, so
// every patch wires it up without being asked.
export const dualModule = {
  ...conditionalModule,
  quantity: 2,
  racks: [{ id: 1, name: 'main rack', quantity: 2 }],
  bridges: [
    {
      id: 91,
      module_id: 1,
      manufacturer: 'Omnitone',
      name: '7Path',
      self: true,
      description: null,
      jacks: [],
    },
  ],
};

export const videosModule = {
  id: 1,
  manufacturer: 'Make Noise',
  name: 'Maths',
  manual_status: 'found',
  analysis_status: 'complete',
  summary: 'x',
  quantity: 1,
  racks: [{ id: 1, name: 'main rack', quantity: 1 }],
  manuals: [],
  components: [],
  videos: [
    {
      id: 5,
      video_id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Maths tricks',
      channel: 'Synth Channel',
      duration_seconds: 300,
      status: 'complete',
      summary: '## Slew plucks\n\nPatch the EOR out into…',
      error: null,
    },
    {
      id: 6,
      video_id: 'AAAAAAAAAAA',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      title: null,
      channel: null,
      duration_seconds: null,
      status: 'downloading',
      summary: null,
      error: null,
    },
    {
      id: 7,
      video_id: 'BBBBBBBBBBB',
      url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
      title: 'broken one',
      channel: 'Someone',
      duration_seconds: 60,
      status: 'failed',
      summary: null,
      error: 'yt-dlp failed (exit 1): video unavailable',
    },
  ],
  clips: [
    {
      id: 12,
      module_id: 1,
      patch_id: 7,
      patch_name: 'Krell',
      device_name: 'Bench scope',
      title: 'EOR rising',
      caption: null,
      video_format: 'webm',
      duration_seconds: 10,
      captured_at: '2026-08-12T18:00:00Z',
      channels: [
        {
          id: 1,
          channel_index: 1,
          label: 'Make Noise Maths — EOR',
          signal_type: 'cv',
          component_name: 'Input 2',
          source_description: 'patched from Make Noise Maths EOR',
        },
      ],
    },
  ],
};
