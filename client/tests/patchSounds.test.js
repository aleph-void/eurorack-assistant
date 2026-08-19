import { describe, it, expect } from 'vitest';
import { createPatchSounds, CUE_NAMES } from '../src/patchSounds.js';

// An audio context that writes down what it was asked to play.
function fakeAudio({ state = 'running' } = {}) {
  const played = [];
  const context = {
    state,
    currentTime: 0,
    destination: {},
    resumed: 0,
    closed: 0,
    createOscillator() {
      const oscillator = {
        type: '',
        frequency: { setValueAtTime: (v) => played.push(v), linearRampToValueAtTime: () => {} },
        connect() {},
        start() {},
        stop() {},
      };
      return oscillator;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect() {},
      };
    },
    resume() {
      this.resumed += 1;
      this.state = 'running';
    },
    close() {
      this.closed += 1;
    },
  };
  return { played, context, AudioContextImpl: function () { return context; } };
}

describe('the cues', () => {
  it('answers a plugged cable with a rising interval and a pulled one with a falling interval', () => {
    const { played, AudioContextImpl } = fakeAudio();
    const sounds = createPatchSounds({ AudioContextImpl });
    sounds.success();
    expect(played[1]).toBeGreaterThan(played[0]);
    played.length = 0;
    sounds.undo();
    expect(played[1]).toBeLessThan(played[0]);
  });

  it('answers a refusal well below either of them', () => {
    const { played, AudioContextImpl } = fakeAudio();
    createPatchSounds({ AudioContextImpl }).failure();
    expect(played[0]).toBeLessThan(300);
  });

  it('answers "which one?" with something that is neither', () => {
    const { played, AudioContextImpl } = fakeAudio();
    createPatchSounds({ AudioContextImpl }).ambiguous();
    expect(played).toHaveLength(3);
    expect(new Set(played).size).toBe(1);
  });

  it('has a cue for everything it says it has', () => {
    const { played, AudioContextImpl } = fakeAudio();
    const sounds = createPatchSounds({ AudioContextImpl });
    for (const name of CUE_NAMES) {
      played.length = 0;
      sounds.play(name);
      expect(played.length).toBeGreaterThan(0);
    }
  });

  it('makes no noise at all when it is turned off', () => {
    const { played, AudioContextImpl } = fakeAudio();
    const sounds = createPatchSounds({ AudioContextImpl, enabled: false });
    sounds.success();
    expect(played).toHaveLength(0);
    sounds.update({ enabled: true });
    sounds.success();
    expect(played.length).toBeGreaterThan(0);
  });

  it('wakes up an audio context the browser suspended before the first click', () => {
    const { context, AudioContextImpl } = fakeAudio({ state: 'suspended' });
    createPatchSounds({ AudioContextImpl }).listening();
    expect(context.resumed).toBe(1);
  });

  it('does not fall over in a browser with no Web Audio', () => {
    const sounds = createPatchSounds({ AudioContextImpl: null });
    expect(() => sounds.success()).not.toThrow();
  });
});

describe('reading errors out loud', () => {
  const speech = () => {
    const spoken = [];
    return {
      spoken,
      speechSynthesisImpl: { cancel() {}, speak: (u) => spoken.push(u.text) },
      UtteranceImpl: function (text) {
        this.text = text;
      },
    };
  };

  it('stays quiet unless it was asked for', () => {
    const { spoken, speechSynthesisImpl, UtteranceImpl } = speech();
    const { AudioContextImpl } = fakeAudio();
    createPatchSounds({ AudioContextImpl, speechSynthesisImpl, UtteranceImpl }).failure('nope');
    expect(spoken).toHaveLength(0);
  });

  it('says the server’s refusal, which is the part a beep cannot carry', () => {
    const { spoken, speechSynthesisImpl, UtteranceImpl } = speech();
    const { AudioContextImpl } = fakeAudio();
    createPatchSounds({
      AudioContextImpl,
      speechSynthesisImpl,
      UtteranceImpl,
      speakErrors: true,
    }).failure("'Clock' already has a cable in it");
    expect(spoken).toEqual(["'Clock' already has a cable in it"]);
  });
});
