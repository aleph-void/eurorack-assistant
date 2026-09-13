// Composition payloads the composition pages are tested against: one
// storyboard with two scenes and two parts, and its mapping onto the Krell
// patch of patchFixtures.js.

export const tide = {
  id: 3,
  name: 'Tide',
  description: 'a slow one',
  tempo_bpm: 92,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  scenes: [
    { id: 10, name: 'Intro', description: 'just the wash', duration_seconds: 90, position: 0 },
    { id: 11, name: 'Build', description: null, duration_seconds: null, position: 1 },
  ],
  elements: [
    { id: 20, name: 'Bass', kind: 'voice', description: null, position: 0 },
    { id: 21, name: 'Kick', kind: 'rhythm', description: 'four on the floor', position: 1 },
  ],
  cells: [
    { id: 30, scene_id: 10, element_id: 20, action: 'enter', note: 'fade in over 8 bars' },
    { id: 31, scene_id: 11, element_id: 20, action: 'change', note: 'open the filter' },
    { id: 32, scene_id: 11, element_id: 21, action: 'enter', note: null },
  ],
  patches: [
    {
      id: 40,
      composition_id: 3,
      patch_id: 7,
      patch_name: 'Krell',
      rack_name: 'main rack',
      system_name: null,
      notes: 'the small-case version',
      mapping_count: 2,
      mapped_element_count: 1,
      element_count: 2,
    },
  ],
};

export const tideOnKrell = {
  id: 40,
  composition_id: 3,
  composition_name: 'Tide',
  patch_id: 7,
  patch_name: 'Krell',
  rack_name: 'main rack',
  system_name: null,
  notes: 'the small-case version',
  elements: tide.elements,
  mappings: [
    {
      id: 50,
      element_id: 20,
      kind: 'component',
      patch_module_id: 11,
      component_id: 3,
      group_id: null,
      cable_id: null,
      target_label: 'Make Noise Maths · Rise',
      note: 'ride it',
      position: 0,
      live: true,
    },
    {
      id: 51,
      element_id: 20,
      kind: 'cable',
      patch_module_id: null,
      component_id: null,
      group_id: null,
      cable_id: 999,
      target_label: 'ALM Pam Out 1 → Make Noise Maths Signal In',
      note: null,
      position: 1,
      live: false,
    },
  ],
};

export const compositionPage = {
  total: 1,
  limit: 100,
  has_more: false,
  next_before: null,
  compositions: [
    {
      id: 3,
      name: 'Tide',
      description: 'a slow one',
      tempo_bpm: 92,
      scene_count: 2,
      element_count: 2,
      patch_count: 1,
    },
  ],
};
