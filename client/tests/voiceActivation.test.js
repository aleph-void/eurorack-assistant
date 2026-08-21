import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceActivation,
  afterWakeWord,
  isContinuous,
  matchKeyPhrase,
} from '../src/voiceActivation.js';

const fakeInput = () => ({ start: vi.fn(), stop: vi.fn(), close: vi.fn(), starts: 0 });

// A window that only remembers who asked to be told about what.
function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type, event = {}) => listeners.get(type)?.({ preventDefault() {}, ...event }),
    has: (type) => listeners.has(type),
  };
}

describe('push to talk', () => {
  it('opens the microphone while the key is down and closes it on the way up', async () => {
    const input = fakeInput();
    const target = fakeTarget();
    const activation = createVoiceActivation({ mode: 'ptt', input, target });
    await activation.attach();

    target.fire('keydown', { code: 'Space' });
    expect(input.start).toHaveBeenCalledTimes(1);
    expect(activation.armed).toBe(true);

    target.fire('keyup', { code: 'Space' });
    expect(input.stop).toHaveBeenCalledTimes(1);
    expect(activation.armed).toBe(false);
  });

  it('ignores the auto-repeat of a held key', async () => {
    const input = fakeInput();
    const target = fakeTarget();
    await createVoiceActivation({ mode: 'ptt', input, target }).attach();
    target.fire('keydown', { code: 'Space' });
    target.fire('keydown', { code: 'Space', repeat: true });
    expect(input.start).toHaveBeenCalledTimes(1);
  });

  it('leaves the space bar alone while a form field has it', async () => {
    const input = fakeInput();
    const target = fakeTarget();
    await createVoiceActivation({ mode: 'ptt', input, target }).attach();
    target.fire('keydown', { code: 'Space', target: { tagName: 'INPUT' } });
    expect(input.start).not.toHaveBeenCalled();
  });

  it('does not leave the microphone open when the window loses focus mid-press', async () => {
    const input = fakeInput();
    const target = fakeTarget();
    const activation = createVoiceActivation({ mode: 'ptt', input, target });
    await activation.attach();
    target.fire('keydown', { code: 'Space' });
    target.fire('blur');
    expect(activation.armed).toBe(false);
    expect(input.stop).toHaveBeenCalled();
  });

  it('takes its listeners back off the window', async () => {
    const target = fakeTarget();
    const activation = createVoiceActivation({ mode: 'ptt', input: fakeInput(), target });
    await activation.attach();
    activation.detach();
    expect(target.has('keydown')).toBe(false);
  });
});

describe('patch mode', () => {
  it('is a switch rather than a button', async () => {
    const input = fakeInput();
    const activation = createVoiceActivation({ mode: 'toggle', input, target: fakeTarget() });
    await activation.attach();
    expect(input.start).not.toHaveBeenCalled();
    activation.toggle();
    expect(activation.armed).toBe(true);
    activation.toggle();
    expect(activation.armed).toBe(false);
  });

  it('and it, unlike push to talk, keeps the recogniser running', () => {
    expect(isContinuous('toggle')).toBe(true);
    expect(isContinuous('wake')).toBe(true);
    expect(isContinuous('ptt')).toBe(false);
  });
});

describe('wake words', () => {
  it('starts listening the moment it is attached', async () => {
    const input = fakeInput();
    await createVoiceActivation({ mode: 'wake', input, target: fakeTarget() }).attach();
    expect(input.start).toHaveBeenCalled();
  });

  it('hands over only what came after the wake word', () => {
    expect(afterWakeWord('patch maths eor to div clock')).toBe('maths eor to div clock');
    expect(afterWakeWord('hey rack undo that')).toBe('undo that');
  });

  it('tolerates a wake word the recogniser half heard', () => {
    expect(afterWakeWord('hey rock undo that')).toBe('undo that');
  });

  it('is deaf to a wake word buried in a sentence', () => {
    expect(afterWakeWord('unplug the patch cable from maths')).toBeNull();
    expect(afterWakeWord('')).toBeNull();
  });

  it('passes the whole sentence through in every other mode', () => {
    const activation = createVoiceActivation({ mode: 'ptt', input: fakeInput(), target: fakeTarget() });
    expect(activation.commandFrom('connect maths to div')).toEqual({
      transcript: 'connect maths to div',
      alternatives: [{ transcript: 'connect maths to div', confidence: 1 }],
    });
  });

  // The recogniser hands back several readings of one breath, and the wake
  // word has to come off all of them — dropping to the best one throws away
  // the readings the parser is better at choosing between than the recogniser.
  it('takes the wake word off every reading of the same breath', () => {
    const activation = createVoiceActivation({ mode: 'wake', input: fakeInput(), target: fakeTarget() });
    const command = activation.commandFrom('patch maths to div', [
      { transcript: 'patch maths to div', confidence: 0.9 },
      { transcript: 'patch mats to dave', confidence: 0.4 },
    ]);
    expect(command.transcript).toBe('maths to div');
    expect(command.alternatives).toEqual([
      { transcript: 'maths to div', confidence: 0.9 },
      { transcript: 'mats to dave', confidence: 0.4 },
    ]);
  });
});

// ---- the key phrase ----

// The phrase listener is a second recogniser: Whisper, always on, hearing the
// room. The command recogniser is the one `input` stands for, and it is only
// ever opened after the phrase has been heard.
function phraseSetup(options = {}) {
  const input = fakeInput();
  const listener = { start: vi.fn(), stop: vi.fn(), close: vi.fn(), onResult: null };
  const onCommand = vi.fn();
  const onPhrase = vi.fn();
  const activation = createVoiceActivation({
    mode: 'phrase',
    input,
    target: fakeTarget(),
    createPhraseInput: (opts) => {
      listener.onResult = opts.onResult;
      return listener;
    },
    onCommand,
    onPhrase,
    ...options,
  });
  const hears = (transcript) => listener.onResult({ transcript, alternatives: [] });
  return { activation, input, listener, hears, onCommand, onPhrase };
}

describe('the key phrase', () => {
  it('finds the phrase wherever in the sentence it was said, and what followed it', () => {
    expect(matchKeyPhrase('create connection between maths and div')).toEqual({
      phrase: 'create connection between',
      intent: 'connect',
      rest: 'maths and div',
    });
    expect(matchKeyPhrase('okay, create connection between maths and div').rest).toBe(
      'maths and div'
    );
    expect(matchKeyPhrase('create connection between').rest).toBe('');
    expect(matchKeyPhrase('connect maths to div')).toBeNull();
  });

  it('tells the two phrases apart even though they share two words', () => {
    expect(matchKeyPhrase('disconnect connection between maths and div')).toMatchObject({
      intent: 'disconnect',
      rest: 'maths and div',
    });
    expect(matchKeyPhrase('creates connection between maths and div')).toMatchObject({
      intent: 'connect',
    });
  });

  it('listens to the room without opening the command recogniser', async () => {
    const { activation, input, listener } = phraseSetup();
    await activation.attach();
    expect(listener.start).toHaveBeenCalledTimes(1);
    expect(input.start).not.toHaveBeenCalled();
    expect(activation.armed).toBe(false);
    expect(activation.waiting).toBe(true);
  });

  it('opens the command recogniser once the phrase is heard, and closes the listener', async () => {
    const { activation, input, listener, hears, onPhrase } = phraseSetup();
    await activation.attach();
    hears('the filter sounds good');
    expect(input.start).not.toHaveBeenCalled();

    hears('create connection between');
    expect(onPhrase).toHaveBeenCalledWith('connect', '');
    expect(input.start).toHaveBeenCalledTimes(1);
    expect(listener.stop).toHaveBeenCalledTimes(1);
    expect(activation.armed).toBe(true);
  });

  it('puts the verb the phrase meant in front of what the browser then heard', async () => {
    const { activation, hears, input, listener } = phraseSetup();
    await activation.attach();
    hears('disconnect connection between');
    const command = activation.commandFrom('maths eor and div clock', [
      { transcript: 'maths eor and div clock', confidence: 0.9 },
      { transcript: 'mats e o r and dave clock', confidence: 0.3 },
    ]);
    expect(command.transcript).toBe('disconnect maths eor and div clock');
    expect(command.alternatives[1].transcript).toBe('disconnect mats e o r and dave clock');
    // The turn is over: the room goes back to being listened to for the phrase.
    expect(activation.armed).toBe(false);
    expect(input.stop).toHaveBeenCalled();
    expect(listener.start).toHaveBeenCalledTimes(2);
  });

  it('ignores what the command recogniser hears when no phrase was said', async () => {
    const { activation } = phraseSetup();
    await activation.attach();
    expect(activation.commandFrom('maths and div')).toBeNull();
  });

  it('uses what Whisper already heard when the whole cable was said in one breath', async () => {
    vi.useFakeTimers();
    try {
      const { activation, hears, onCommand, listener } = phraseSetup({ fallbackMs: 2000 });
      await activation.attach();
      hears('create connection between maths out and div clock');
      expect(onCommand).not.toHaveBeenCalled();
      // The browser's recogniser is given its moment to hear the cable said
      // again before what Whisper heard is used.
      vi.advanceTimersByTime(2000);
      expect(onCommand).toHaveBeenCalledWith('connect maths out and div clock', [
        { transcript: 'connect maths out and div clock', confidence: 1 },
      ]);
      expect(activation.armed).toBe(false);
      expect(listener.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not say it twice when the browser answered first', async () => {
    vi.useFakeTimers();
    try {
      const { activation, hears, onCommand } = phraseSetup({ fallbackMs: 2000 });
      await activation.attach();
      hears('create connection between maths out and div clock');
      activation.commandFrom('maths out and div clock', []);
      vi.advanceTimersByTime(5000);
      expect(onCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the command recogniser again when nothing at all is said', async () => {
    vi.useFakeTimers();
    try {
      const { activation, hears, input } = phraseSetup({ commandWindowMs: 8000 });
      await activation.attach();
      hears('create connection between');
      expect(activation.armed).toBe(true);
      vi.advanceTimersByTime(8000);
      expect(activation.armed).toBe(false);
      expect(input.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the microphone back when the page is left', async () => {
    const { activation, listener } = phraseSetup();
    await activation.attach();
    activation.detach();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  it('holding the button is holding it to say a cable', async () => {
    const { activation, input, onPhrase } = phraseSetup();
    await activation.attach();
    activation.press();
    expect(onPhrase).toHaveBeenCalledWith('connect', '');
    expect(input.start).toHaveBeenCalledTimes(1);
    activation.release();
    expect(activation.armed).toBe(false);
  });

  it('is one utterance at a time, like push to talk', () => {
    expect(isContinuous('phrase')).toBe(false);
  });
});

// ---- MIDI ----

function fakeMidi() {
  const port = { onmidimessage: null };
  const access = { inputs: new Map([['a', port]]), onstatechange: null };
  return { port, access, requestMIDIAccess: vi.fn(async () => access) };
}

describe('a footswitch on the desk', () => {
  it('arms on note on and disarms on note off', async () => {
    const input = fakeInput();
    const { port, requestMIDIAccess } = fakeMidi();
    const activation = createVoiceActivation({
      mode: 'midi',
      input,
      target: fakeTarget(),
      binding: { type: 'note', number: 60, channel: 1 },
      requestMIDIAccess,
    });
    await activation.attach();
    port.onmidimessage({ data: [0x90, 60, 100] });
    expect(activation.armed).toBe(true);
    port.onmidimessage({ data: [0x80, 60, 0] });
    expect(activation.armed).toBe(false);
  });

  it('treats a note on with no velocity as the release it is', async () => {
    const input = fakeInput();
    const { port, requestMIDIAccess } = fakeMidi();
    const activation = createVoiceActivation({
      mode: 'midi',
      input,
      target: fakeTarget(),
      binding: { type: 'note', number: 60, channel: 1 },
      requestMIDIAccess,
    });
    await activation.attach();
    port.onmidimessage({ data: [0x90, 60, 100] });
    port.onmidimessage({ data: [0x90, 60, 0] });
    expect(activation.armed).toBe(false);
  });

  it('ignores a switch that is not the one it was told about', async () => {
    const { port, requestMIDIAccess } = fakeMidi();
    const activation = createVoiceActivation({
      mode: 'midi',
      input: fakeInput(),
      target: fakeTarget(),
      binding: { type: 'note', number: 60, channel: 1 },
      requestMIDIAccess,
    });
    await activation.attach();
    port.onmidimessage({ data: [0x90, 61, 100] });
    expect(activation.armed).toBe(false);
  });

  it('learns the next switch pressed instead of acting on it', async () => {
    const input = fakeInput();
    const onBinding = vi.fn();
    const { port, requestMIDIAccess } = fakeMidi();
    const activation = createVoiceActivation({
      mode: 'midi',
      input,
      target: fakeTarget(),
      requestMIDIAccess,
      onBinding,
    });
    await activation.attach();
    await activation.learnBinding();
    port.onmidimessage({ data: [0xb3, 64, 127] });
    expect(onBinding).toHaveBeenCalledWith({ type: 'cc', number: 64, channel: 4 });
    expect(activation.armed).toBe(false);
    // And from then on that switch is the microphone.
    port.onmidimessage({ data: [0xb3, 64, 127] });
    expect(activation.armed).toBe(true);
  });

  it('does not wire up a footswitch to an activation that has already been torn down', async () => {
    // The browser takes its time asking for MIDI, and the component does not
    // await attach() — so a setting flipped in that window used to leave the
    // switch talking to a microphone that had been closed.
    const port = { onmidimessage: null };
    let grant;
    const access = { inputs: new Map([['a', port]]), onstatechange: null };
    const input = fakeInput();
    const activation = createVoiceActivation({
      mode: 'midi',
      input,
      target: fakeTarget(),
      binding: { type: 'note', number: 60, channel: 1 },
      requestMIDIAccess: () => new Promise((resolve) => {
        grant = () => resolve(access);
      }),
    });
    activation.attach();
    activation.detach();
    grant();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(port.onmidimessage).toBeNull();
    port.onmidimessage?.({ data: [0x90, 60, 100] });
    expect(input.start).not.toHaveBeenCalled();
    expect(activation.armed).toBe(false);
  });

  it('says so when the browser has no MIDI', async () => {
    const onError = vi.fn();
    await createVoiceActivation({
      mode: 'midi',
      input: fakeInput(),
      target: fakeTarget(),
      requestMIDIAccess: null,
      onError,
    }).attach();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/no Web MIDI/));
  });
});
