// Telling you what happened without making you look.
//
// The whole point of patching by voice is that you are looking at the rack and
// not at the screen, so the answer has to arrive through the same ear the
// question left by. Four cues, deliberately far apart so they are never
// confused across a room with a synth running in it:
//
//   listening   one short high blip     the mic is open
//   success     a rising fifth          the cable is in
//   ambiguous   three level pips        heard you, need one more word
//   failure     a low falling buzz      nothing was plugged
//   undo        a falling fifth         the cable came back out
//
// Short, quiet and dry — a reverb tail would sit on top of whatever the rack
// is doing. The AudioContext is made on first use, because browsers will not
// start one before the page has been touched, and is injectable for tests.

const CUES = {
  listening: { steps: [[1320, 0.05]], type: 'sine', gain: 0.18 },
  success: {
    steps: [
      [660, 0.07],
      [990, 0.12],
    ],
    type: 'triangle',
    gain: 0.3,
  },
  ambiguous: {
    steps: [
      [880, 0.05],
      [880, 0.05],
      [880, 0.05],
    ],
    type: 'sine',
    gain: 0.26,
  },
  failure: { steps: [[180, 0.3]], type: 'sawtooth', gain: 0.22, slideTo: 110 },
  undo: {
    steps: [
      [990, 0.07],
      [660, 0.12],
    ],
    type: 'triangle',
    gain: 0.26,
  },
};

export const CUE_NAMES = Object.freeze(Object.keys(CUES));

export function createPatchSounds({
  AudioContextImpl = typeof window !== 'undefined'
    ? window.AudioContext || window.webkitAudioContext
    : null,
  speechSynthesisImpl = typeof window !== 'undefined' ? window.speechSynthesis : null,
  UtteranceImpl = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null,
  volume = 0.7,
  enabled = true,
  speakErrors = false,
} = {}) {
  let context = null;
  const settings = { volume, enabled, speakErrors };

  function open() {
    if (!settings.enabled || !AudioContextImpl) return null;
    if (!context) context = new AudioContextImpl();
    // Suspended is what an AudioContext made before the first click looks like.
    if (context.state === 'suspended') context.resume?.();
    return context;
  }

  function play(name) {
    const cue = CUES[name];
    const audio = cue ? open() : null;
    if (!audio) return;
    let at = audio.currentTime + 0.01;
    for (const [frequency, seconds] of cue.steps) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = cue.type;
      oscillator.frequency.setValueAtTime(frequency, at);
      if (cue.slideTo) oscillator.frequency.linearRampToValueAtTime(cue.slideTo, at + seconds);

      // A short attack and a decay to near-silence: a square-edged blip clicks,
      // and a click sounds like a fault rather than an answer.
      const peak = cue.gain * settings.volume;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + seconds + 0.02);
      at += seconds + 0.015;
    }
  }

  // Said out loud only when asked for: the cues carry the yes and the no, and
  // this is for the part a beep cannot carry — which jack was already in use.
  function speak(text) {
    if (!settings.speakErrors || !text || !speechSynthesisImpl || !UtteranceImpl) return;
    try {
      speechSynthesisImpl.cancel();
      const utterance = new UtteranceImpl(String(text));
      utterance.rate = 1.15;
      utterance.volume = settings.volume;
      speechSynthesisImpl.speak(utterance);
    } catch {
      /* speech synthesis is a nicety */
    }
  }

  return {
    listening: () => play('listening'),
    success: () => play('success'),
    ambiguous: () => play('ambiguous'),
    failure: (message) => {
      play('failure');
      speak(message);
    },
    undo: () => play('undo'),
    play,
    speak,
    // A cue you cannot hear is worse than none, so the settings panel plays
    // one as you move the slider.
    preview: (name) => play(name),
    update(next = {}) {
      Object.assign(settings, next);
      if (!settings.enabled && context) {
        context.close?.();
        context = null;
      }
    },
    get settings() {
      return { ...settings };
    },
    close() {
      context?.close?.();
      context = null;
    },
  };
}
