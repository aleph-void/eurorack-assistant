import { describe, it, expect } from 'vitest';
import { matchEndpoint, parseQuickCable, splitQuickCable } from '../src/patchQuickCable.js';

const jack = (patch_module_id, component_id, module_label, jack_name, extra = {}) => ({
  patch_module_id,
  component_id,
  module_label,
  jack_name,
  ...extra,
});

const OUTPUTS = [
  jack(11, 2, 'Make Noise Maths', 'EOR'),
  jack(11, 3, 'Make Noise Maths', 'OUT 4'),
  jack(13, 5, 'Doepfer A-180-2', 'M1'),
  jack(13, 6, 'Doepfer A-180-2', 'M2'),
];
const INPUTS = [
  jack(11, 1, 'Make Noise Maths', 'Signal In'),
  jack(12, 7, 'Intellijel Optomix (the voice)', 'CH1 IN'),
  jack(12, 8, 'Intellijel Optomix (the voice)', 'CH1 CTRL', { disabled: true }),
];

describe('splitQuickCable', () => {
  it('splits on every arrow spelling', () => {
    for (const line of ['maths eor > optomix ch1', 'maths eor -> optomix ch1', 'maths eor→optomix ch1']) {
      expect(splitQuickCable(line)).toMatchObject({ from: 'maths eor', to: 'optomix ch1' });
    }
  });
});

describe('matchEndpoint', () => {
  it('matches on any word of the module or the jack', () => {
    expect(matchEndpoint('maths eor', OUTPUTS).best).toMatchObject({ component_id: 2 });
    expect(matchEndpoint('eor', OUTPUTS).best).toMatchObject({ component_id: 2 });
    // The role a patch gives an instance is part of its name.
    expect(matchEndpoint('voice ch1 in', INPUTS).best).toMatchObject({ component_id: 7 });
  });

  it('prefers the candidate whose jack is named outright', () => {
    // 'm1' matches only M1, but a looser word could match both.
    expect(matchEndpoint('doepfer m1', OUTPUTS).best).toMatchObject({ component_id: 5 });
  });

  it('reports every candidate when the words do not pin one down', () => {
    const found = matchEndpoint('doepfer m', OUTPUTS);
    expect(found.best).toBeNull();
    expect(found.matches.map((m) => m.jack_name)).toEqual(['M1', 'M2']);
  });

  it('finds nothing for words that match nothing', () => {
    expect(matchEndpoint('pamela', OUTPUTS)).toEqual({ matches: [], best: null });
  });
});

describe('parseQuickCable', () => {
  const candidates = { from: OUTPUTS, to: INPUTS };

  it('resolves both ends of a line', () => {
    const parsed = parseQuickCable('maths eor > optomix ch1 in', candidates);
    expect(parsed.error).toBe('');
    expect(parsed.from).toMatchObject({ patch_module_id: 11, component_id: 2 });
    expect(parsed.to).toMatchObject({ patch_module_id: 12, component_id: 7 });
  });

  it('says which side is the problem', () => {
    expect(parseQuickCable('maths eor', candidates).error).toMatch(/both ends/);
    expect(parseQuickCable('maths eor > pamela', candidates).error).toMatch(
      /destination side matches "pamela"/
    );
    const ambiguous = parseQuickCable('doepfer m > optomix ch1 in', candidates);
    expect(ambiguous.error).toMatch(/could be 2 different jacks/);
    expect(ambiguous.matches).toHaveLength(2);
  });

  it('refuses an input that already has a cable in it', () => {
    const parsed = parseQuickCable('maths eor > optomix ch1 ctrl', candidates);
    expect(parsed.to).toMatchObject({ component_id: 8 });
    expect(parsed.error).toMatch(/already has a cable in it/);
  });

  it('stays quiet on an empty line', () => {
    expect(parseQuickCable('', candidates)).toMatchObject({ error: '', from: null, to: null });
  });
});
