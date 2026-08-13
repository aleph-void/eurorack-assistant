import { describe, it, expect } from 'vitest';
import {
  parseVoiceCommand,
  parseBestAlternative,
  matchSpokenEndpoint,
  pickedOption,
  describeEndpoint,
} from '../src/voiceCommand.js';

// A small but honest rack: two modules whose names speech gets wrong, a
// manufacturer that is a number, unnamed numbered outputs, and two modules
// from the same maker so the module name alone is never enough.
let nextId = 1;
const jacks = (moduleId, label, names, type) =>
  names.map((name, index) => ({
    patch_module_id: moduleId,
    component_id: (nextId += 1),
    module_label: label,
    jack_name: name,
    jack_type: type,
    jack_index: index + 1,
    disabled: false,
  }));

const from = [
  ...jacks(1, 'Make Noise Maths', ['Ch 1 Out', 'Ch 4 Out', 'SUM', 'OR', 'EOR', 'EOC'], 'output_jack'),
  ...jacks(2, '2hp Div', ['Out'], 'output_jack'),
  ...jacks(3, 'Mutable Instruments Plaits', ['Out', 'Aux'], 'output_jack'),
  ...jacks(4, 'Intellijel Quadrax', ['1', '2', '3', '4'], 'output_jack'),
];
const to = [
  ...jacks(2, '2hp Div', ['Clock', 'Reset'], 'input_jack'),
  ...jacks(1, 'Make Noise Maths', ['Ch 1 Signal', 'Ch 1 Trigger', 'Ch 4 Signal'], 'input_jack'),
  ...jacks(3, 'Mutable Instruments Plaits', ['V/Oct', 'Trigger', 'Level', 'FM'], 'input_jack'),
  ...jacks(5, 'Make Noise Optomix', ['Ch1 Signal', 'Ch1 Control'], 'input_jack'),
];
const cables = [
  { cable_id: 9, module_label: 'Make Noise Maths EOR', jack_name: '2hp Div Clock' },
  { cable_id: 10, module_label: 'Mutable Instruments Plaits Out', jack_name: 'Make Noise Optomix Ch1 Signal' },
];
const context = { from, to, cables };
const read = (text, ctx = context) => parseVoiceCommand(text, ctx);
const ends = (result) => [describeEndpoint(result.from), describeEndpoint(result.to)];

describe('reading a cable out loud', () => {
  it('plugs the sentence in the prompt', () => {
    const result = read('connect make noise maths out 1 to 2hp div clock in');
    expect(result.intent).toBe('connect');
    expect(ends(result)).toEqual(['Make Noise Maths — Ch 1 Out', '2hp Div — Clock']);
  });

  it('knows which "to" is the join and which is the manufacturer', () => {
    const result = read('connect make noise maths out one to two h p div clock in');
    expect(ends(result)).toEqual(['Make Noise Maths — Ch 1 Out', '2hp Div — Clock']);
    expect(result.error).toBe('');
  });

  it('takes the join however the recogniser spelled it', () => {
    // "to", "too" and "two" are the same sound, and a recogniser picks between
    // them more or less at random.
    for (const join of ['to', 'too', 'two', 'into']) {
      const result = read(`connect maths e o r ${join} 2hp div clock`);
      expect(ends(result), join).toEqual(['Make Noise Maths — EOR', '2hp Div — Clock']);
    }
  });

  it('finds a manufacturer that is a number, however it was heard', () => {
    const fourms = [
      { patch_module_id: 8, component_id: 800, module_label: '4ms Ensemble Oscillator', jack_name: 'Out', jack_index: 1, disabled: false },
      ...from,
    ];
    for (const heard of ['four ms', '4ms', 'for ms']) {
      const result = parseVoiceCommand(`connect ${heard} ensemble oscillator out to plaits fm`, {
        from: fourms,
        to,
        cables,
      });
      expect(result.from?.module_label, heard).toBe('4ms Ensemble Oscillator');
    }
  });

  it('reads letters said one at a time', () => {
    const result = read('patch maths e o r into plaits trigger');
    expect(ends(result)).toEqual([
      'Make Noise Maths — EOR',
      'Mutable Instruments Plaits — Trigger',
    ]);
  });

  it('gets there through the names speech gets wrong', () => {
    const result = read('connect moths channel one out to optimix channel one signal');
    expect(ends(result)).toEqual(['Make Noise Maths — Ch 1 Out', 'Make Noise Optomix — Ch1 Signal']);
  });

  it('counts unnamed outputs when they are asked for by number', () => {
    const result = read('plug quadrax one into plaits v oct');
    expect(ends(result)).toEqual(['Intellijel Quadrax — 1', 'Mutable Instruments Plaits — V/Oct']);
  });

  it('ignores the words said out of habit', () => {
    const result = read('please patch the sum output on maths to the plaits level input');
    expect(ends(result)).toEqual(['Make Noise Maths — SUM', 'Mutable Instruments Plaits — Level']);
  });

  it('never mistakes out one for out four', () => {
    const result = read('connect maths channel four out to plaits level');
    expect(result.from.jack_name).toBe('Ch 4 Out');
  });

  it('takes the modifiers off the end of the sentence', () => {
    const result = read('connect maths ch 1 out to plaits fm stacked');
    expect(result.stacked).toBe(true);
    expect(result.to.jack_name).toBe('FM');
  });
});

describe('refusing to guess', () => {
  it('asks rather than picking one of five outputs', () => {
    const result = read('connect maths out to plaits');
    expect(result.from).toBeNull();
    expect(result.error).toMatch(/Which source/);
    expect(result.options.length).toBeGreaterThan(1);
    expect(result.confidence).toBeLessThan(0.75);
  });

  it('says so when nothing in the rack sounds like that', () => {
    const result = read('connect a completely different module to another one');
    expect(result.from).toBeNull();
    expect(result.error).toMatch(/Nothing on the source side/);
  });

  it('will not read a sentence with no join in it', () => {
    const result = read('connect maths');
    expect(result.error).toMatch(/one cable/);
  });

  it('flags a destination that is already fed', () => {
    const taken = to.map((c) => (c.jack_name === 'Clock' ? { ...c, disabled: true } : c));
    const result = read('connect maths e o r to 2hp div clock', { from, to: taken, cables });
    expect(result.error).toMatch(/already has a cable in it/);
  });

  it('says nothing at all about an empty utterance', () => {
    const result = read('');
    expect(result.intent).toBe('unknown');
    expect(result.error).toBe('');
  });
});

describe('the other things you can say', () => {
  it('pulls a cable back out by name', () => {
    const result = read('unplug maths e o r');
    expect(result.intent).toBe('disconnect');
    expect(result.cable.cable_id).toBe(9);
  });

  it('asks which cable when the name fits two', () => {
    const result = read('disconnect make noise', { from, to, cables });
    expect(result.intent).toBe('disconnect');
    expect(result.cable).toBeNull();
    expect(result.error).toMatch(/Which cable|No cable/);
  });

  it('understands undo and cancel', () => {
    expect(read('undo that').intent).toBe('undo');
    expect(read('scratch that').intent).toBe('undo');
    expect(read('never mind').intent).toBe('cancel');
  });

  it('does not hear undo in the middle of a sentence', () => {
    expect(read('connect maths e o r to plaits trigger').intent).toBe('connect');
  });
});

describe('choosing between what the recogniser offers', () => {
  it('keeps the reading that names a real cable, not the likeliest English', () => {
    const result = parseBestAlternative(
      [
        { transcript: 'connect mats out one to 2 hp dave clock in', confidence: 0.9 },
        { transcript: 'connect maths ch 1 out to 2hp div clock', confidence: 0.4 },
      ],
      context
    );
    expect(ends(result)).toEqual(['Make Noise Maths — Ch 1 Out', '2hp Div — Clock']);
  });

  it('accepts bare strings as readings', () => {
    const result = parseBestAlternative(['patch maths e o r into plaits trigger'], context);
    expect(result.from.jack_name).toBe('EOR');
  });

  it('has an answer for no readings at all', () => {
    expect(parseBestAlternative([], context).intent).toBe('unknown');
  });
});

describe('answering "which one?"', () => {
  it('takes a number, an ordinal, or a number with filler round it', () => {
    expect(pickedOption('one')).toBe(1);
    expect(pickedOption('two')).toBe(2);
    expect(pickedOption('3')).toBe(3);
    expect(pickedOption('the second one')).toBe(2);
    expect(pickedOption('number four')).toBe(4);
  });

  it('refuses to read a whole cable as a pick, however many numbers are in it', () => {
    // The dangerous one: after an ambiguous answer the rack owner gives up on
    // the numbered list and says the cable again. Reading the "one" in
    // "channel one" as a pick documents a cable nobody patched.
    expect(pickedOption('connect maths channel one out to plaits v oct')).toBeNull();
    expect(pickedOption('maths ch 1 out to plaits fm')).toBeNull();
    expect(pickedOption('unplug maths out 2')).toBeNull();
  });

  it('has no answer where there is no number', () => {
    expect(pickedOption('yes please')).toBeNull();
    expect(pickedOption('')).toBeNull();
  });
});

describe('matchSpokenEndpoint', () => {
  it('has nothing to say about an empty phrase or an empty rack', () => {
    expect(matchSpokenEndpoint('', from).best).toBeNull();
    expect(matchSpokenEndpoint('maths', []).best).toBeNull();
  });

  it('prefers a jack that can take the cable over one that cannot', () => {
    const candidates = [
      { ...to[0], disabled: true },
      { ...to[1], jack_name: 'Clock', component_id: 999, disabled: false },
    ];
    expect(matchSpokenEndpoint('2hp div clock', candidates).best.component_id).toBe(999);
  });
});
