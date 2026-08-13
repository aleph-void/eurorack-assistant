import { describe, it, expect, vi } from 'vitest';
import { createVoiceActivation, afterWakeWord, isContinuous } from '../src/voiceActivation.js';

const fakeInput = () => ({ start: vi.fn(), stop: vi.fn(), starts: 0 });

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
    expect(activation.commandFrom('connect maths to div')).toBe('connect maths to div');
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
