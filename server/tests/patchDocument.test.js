import { describe, it, expect } from 'vitest';
import { patchTextDocument } from '../src/services/patchDocument.js';

// patchTextDocument is a pure function of the loadPatchDetail JSON, so these
// tests hand it patches directly — no database, no HTTP.

describe('patchTextDocument', () => {
  it('renders an empty patch without inventing sections', () => {
    const doc = patchTextDocument({ name: 'Blank' });
    expect(doc).toContain('# Patch: Blank');
    expect(doc).not.toContain('Rack:');
    expect(doc).toContain('Nothing is patched yet.');
    expect(doc).toContain('No patch cables.');
    expect(doc).toContain(
      'No control positions recorded — assume nothing about how the controls are set.'
    );
    expect(doc).not.toContain('## Normalled');
    expect(doc).not.toContain('## Signal flow');
  });

  it('names instances with numbering, labels and fallbacks', () => {
    const doc = patchTextDocument({
      name: 'Krell',
      rack_name: 'main rack',
      description: 'Self-generating drone.',
      modules: [
        {
          id: 1,
          manufacturer: 'Make Noise',
          module_name: 'Maths',
          instance: 1,
          live: true,
          label: 'the voice',
          group_id: 10,
        },
        { id: 2, manufacturer: 'Make Noise', module_name: 'Maths', instance: 2, live: true },
        { id: 3, manufacturer: '', module_name: '', instance: 1, live: true },
        {
          id: 4,
          manufacturer: 'external',
          module_name: 'UMC404HD',
          instance: 1,
          live: false,
          external: true,
          // A group id whose group no longer exists earns no note.
          group_id: 99,
        },
        { id: 5, manufacturer: 'ALM', module_name: 'Pam', instance: 1, live: false },
        { id: 6, manufacturer: 'Doepfer', module_name: 'A-110', instance: 1, live: true },
      ],
      groups: [{ id: 10, name: 'Rhythm' }],
      cables: [
        {
          from_patch_module_id: 1,
          from_component_name: 'EOR',
          to_patch_module_id: 2,
          to_component_name: 'Signal In',
        },
        {
          from_patch_module_id: 999,
          from_component_name: 'OUT',
          to_patch_module_id: 4,
          to_component_name: 'IN 1',
          optional: true,
          stacked: true,
          alt_group: 'clock source',
          note: 'try halftime',
        },
        {
          from_patch_module_id: 5,
          from_component_name: 'OUT 1',
          to_patch_module_id: 1,
          to_component_name: 'Both',
        },
      ],
      settings: [{ patch_module_id: 3, component_name: 'Rise', value: '3 o’clock' }],
    });

    expect(doc).toContain('Rack: main rack');
    expect(doc).toContain('Self-generating drone.');
    expect(doc).toContain('- Make Noise Maths (the voice) — in the "Rhythm" group');
    expect(doc).toContain('- Make Noise Maths #2');
    expect(doc).toContain('- unnamed module');
    expect(doc).toContain('- external UMC404HD — gear outside the rack');
    expect(doc).not.toContain('UMC404HD — gear outside the rack, in');
    expect(doc).toContain('- ALM Pam — not in the rack this patch was made from');
    // A rack module nothing is patched into stays out of the modules list…
    expect(doc).toContain('Also in the rack but not patched into anything: Doepfer A-110.');
    expect(doc).not.toContain('- Doepfer A-110');
    // …and cables carry every flag plus the snapshot name of a removed module.
    expect(doc).toContain('- Make Noise Maths (the voice) "EOR" → Make Noise Maths #2 "Signal In"');
    expect(doc).toContain(
      '- (removed module) "OUT" → external UMC404HD "IN 1" ' +
        '(optional; stacked onto the source jack; one of the alternatives in "clock source"; try halftime)'
    );
    expect(doc).toContain('- unnamed module "Rise": 3 o’clock');
  });

  it('writes normalled connections with their break, condition and carried signal', () => {
    const doc = patchTextDocument({
      name: 'Normals',
      modules: [
        { id: 1, manufacturer: 'Intellijel', module_name: 'Atlantix', instance: 1, live: true },
        { id: 2, manufacturer: 'Doepfer', module_name: 'A-110', instance: 1, live: true },
      ],
      cables: [
        {
          from_patch_module_id: 2,
          from_component_name: 'SAW',
          to_patch_module_id: 1,
          to_component_name: 'PWM IN',
        },
      ],
      normalizations: [
        {
          patch_module_id: 1,
          target_component_name: 'PWM IN',
          source_component_name: 'SINE B',
          active: false,
          break_on: 'cable_in',
          condition: { state: 'selected', component_name: 'PWM SOURCE', value: 'left' },
        },
        {
          patch_module_id: 1,
          target_component_name: 'VCF IN',
          source_component_name: 'MIX OUT',
          active: false,
          break_on: 'cable_out',
          break_component_name: 'MIX OUT',
          condition: { state: 'unset', component_name: 'ROUTING', value: 'filter' },
        },
        {
          patch_module_id: 1,
          target_component_name: 'PWM CV',
          source_component_name: null,
          source_label: 'the internal envelope',
          active: true,
          condition: { state: 'other', component_name: 'MODE', value: 'env' },
          signals: [
            {
              kind: 'cable',
              from_patch_module_id: 2,
              from_component_name: 'SAW',
              via: ['MULT 1', 'MULT 2'],
            },
            { kind: 'output', component_name: 'SINE A' },
            { kind: 'internal', label: 'the internal LFO' },
            { kind: 'unpatched' },
          ],
        },
        {
          patch_module_id: 1,
          target_component_name: 'EXP FM',
          source_component_name: 'ENV OUT',
          active: true,
          signals: [],
        },
      ],
    });

    expect(doc).toContain('## Normalled (default) connections');
    // A broken normal names the jack whose cable cancelled it — the target
    // itself when no break jack is recorded.
    expect(doc).toContain(
      '"PWM IN" is normalled to "SINE B" [with PWM SOURCE set to left]' +
        ' — CANCELLED in this patch by a cable into "PWM IN"'
    );
    expect(doc).toContain(
      '"VCF IN" is normalled to "MIX OUT"' +
        ' [only when ROUTING is set to filter, which this patch does not record]' +
        ' — CANCELLED in this patch by a cable out of "MIX OUT"'
    );
    expect(doc).toContain(
      '"PWM CV" is normalled to the internal signal "the internal envelope"' +
        ' [only when MODE is set to env] — ACTIVE, carrying ' +
        '"SAW" from Doepfer A-110 (via MULT 1 → MULT 2); ' +
        '"SINE A" on the same module; the internal LFO; ' +
        'nothing — the chain ends at an unpatched input'
    );
    expect(doc).toContain('"EXP FM" is normalled to "ENV OUT" — ACTIVE, carrying no signal');
  });

  it('indents the signal flow one hop at a time with the right flags', () => {
    const doc = patchTextDocument({
      name: 'Flow',
      modules: [
        { id: 1, manufacturer: 'Doepfer', module_name: 'A-110', instance: 1, live: true },
        { id: 2, manufacturer: 'Make Noise', module_name: 'Maths', instance: 1, live: true },
      ],
      cables: [
        {
          from_patch_module_id: 1,
          from_component_name: 'SAW',
          to_patch_module_id: 2,
          to_component_name: 'Signal In',
        },
      ],
      flow: [
        {
          patch_module_id: 1,
          name: 'SAW',
          kind: 'jack',
          children: [
            {
              patch_module_id: 2,
              name: 'Signal In',
              via: 'cable',
              optional: true,
              port_kind: 'midi_din',
              children: [
                {
                  patch_module_id: 2,
                  name: 'Unity',
                  via: 'mult',
                  merge: true,
                  children: [
                    { patch_module_id: 2, name: 'EOR', via: 'teleport', cycle: true },
                  ],
                },
                {
                  patch_module_id: 2,
                  name: 'Sum',
                  via: 'switch',
                  switched_merge: true,
                  switched: true,
                },
                {
                  patch_module_id: 2,
                  name: 'Inv',
                  via: 'route',
                  switched: true,
                  conditional: true,
                  condition: { state: 'selected', component_name: 'Mode', value: 'Cycle' },
                  truncated: true,
                },
              ],
            },
          ],
        },
        { patch_module_id: 2, name: 'the function generator', kind: 'internal' },
      ],
    });

    expect(doc).toContain('## Signal flow');
    expect(doc).toContain('- Doepfer A-110 "SAW" [signal generator]');
    expect(doc).toContain(
      '  - patch cable → Make Noise Maths "Signal In" [midi din; optional cable]'
    );
    expect(doc).toContain(
      '    - mult copy → Make Noise Maths "Unity" [several signals merge here]'
    );
    // An edge kind the writer does not know keeps its raw name.
    expect(doc).toContain(
      '      - teleport → Make Noise Maths "EOR" [feedback loop back to a jack already in this path]'
    );
    // switched_merge wins over switched when both are set.
    expect(doc).toContain(
      '    - switch position → Make Noise Maths "Sum" [one of these signals at a time, chosen by a switch]'
    );
    expect(doc).toContain(
      '    - internal signal path → Make Noise Maths "Inv" ' +
        '[only in one switch position; with Mode set to Cycle; path not followed further]'
    );
    expect(doc).toContain('- Make Noise Maths "the function generator" [internal source]');
  });
});
