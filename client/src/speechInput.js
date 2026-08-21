// Getting words out of a microphone, two ways, behind one door.
//
// The browser's own recogniser is free, instant and already installed, but it
// is Chrome-family only and it ships your voice to Google — which is a strange
// thing to ask of an app whose whole point is that you host it yourself. So
// Whisper runs as the other option: the model is fetched once, transcription
// happens in a worker on your own machine, and nothing leaves the room.
//
// Both are reached through the same controller, and both hand back a list of
// readings rather than one, because the parser is a far better judge of which
// reading names a real cable than the recogniser is (see parseBestAlternative).
//
// Every browser API used here is injectable, so the tests never touch a
// microphone.

import { createWhisperRecogniser } from './whisperInput.js';

export const ENGINES = Object.freeze([
  { value: 'webspeech', label: 'Browser (Web Speech API)' },
  { value: 'whisper', label: 'Local Whisper (offline, private)' },
]);

// What the browser's recogniser says when it goes wrong, said in terms of
// what to do about it. `network` is the one that catches people out: Chrome's
// recogniser is not on this machine — it streams the audio to Google's
// servers, and a Chromium built without a key for them (most Linux distro
// packages, ungoogled builds, Electron) can never reach the service, so it
// fails this way every single time rather than intermittently. Whisper is the
// answer, and it is already here.
const SERVICE_UNREACHABLE =
  'The browser’s recogniser could not reach its speech service. It is not on this ' +
  'machine — Chrome streams your voice to Google to transcribe it, and many ' +
  'Chromium builds have no key for that service. Switch Recognition to Local ' +
  'Whisper to transcribe on this machine instead.';

export const WEB_SPEECH_ERRORS = Object.freeze({
  'not-allowed': 'Microphone permission was refused',
  'audio-capture': 'No microphone was found',
  network: SERVICE_UNREACHABLE,
  'service-not-allowed': SERVICE_UNREACHABLE,
  'language-not-supported': 'The browser’s recogniser does not speak this language',
});

// The errors that mean this engine will never work here, whatever is said
// into it — as opposed to one bad attempt.
export const ENGINE_UNUSABLE = Object.freeze(['network', 'service-not-allowed']);

const nativeRecognition = () =>
  typeof window === 'undefined'
    ? null
    : window.SpeechRecognition || window.webkitSpeechRecognition || null;

export function engineAvailability({
  RecognitionImpl = nativeRecognition(),
  mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
} = {}) {
  return {
    webspeech: Boolean(RecognitionImpl),
    whisper: Boolean(mediaDevices?.getUserMedia),
  };
}

// ---- the browser's recogniser ----

function createWebSpeechInput({
  lang = 'en-US',
  continuous = false,
  maxAlternatives = 5,
  vocabulary = [],
  onPartial = () => {},
  onResult = () => {},
  onError = () => {},
  onState = () => {},
  RecognitionImpl = nativeRecognition(),
  GrammarListImpl = typeof window !== 'undefined'
    ? window.SpeechGrammarList || window.webkitSpeechGrammarList
    : null,
} = {}) {
  let recognition = null;
  let wanted = false;
  let state = 'idle';

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  function build() {
    const engine = new RecognitionImpl();
    engine.lang = lang;
    engine.continuous = continuous;
    engine.interimResults = true;
    engine.maxAlternatives = maxAlternatives;

    // Chrome ignores this more often than it honours it, but where it is
    // honoured it weights the decoder towards the names in this rack, which is
    // precisely the vocabulary it has never heard of.
    if (GrammarListImpl && vocabulary.length) {
      try {
        const list = new GrammarListImpl();
        const terms = vocabulary.map((t) => String(t).replace(/[^a-z0-9 ]/gi, '')).filter(Boolean);
        list.addFromString(`#JSGF V1.0; grammar rack; public <rack> = ${terms.join(' | ')} ;`, 1);
        engine.grammars = list;
      } catch {
        /* grammars are a nicety, not a requirement */
      }
    }

    engine.onstart = () => setState('listening');
    engine.onaudioend = () => setState(wanted && continuous ? 'listening' : 'thinking');
    engine.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alternatives = Array.from(result).map((alt) => ({
          transcript: alt.transcript,
          confidence: typeof alt.confidence === 'number' ? alt.confidence : 0,
        }));
        if (!alternatives.length) continue;
        if (result.isFinal) onResult({ transcript: alternatives[0].transcript, alternatives });
        else onPartial(alternatives[0].transcript);
      }
    };
    engine.onerror = (event) => {
      // "no-speech" and "aborted" are what a held-and-released button sounds
      // like when nobody said anything. They are not worth a noise.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      const said = WEB_SPEECH_ERRORS[event.error];
      onError(said || `Speech recognition failed (${event.error})`, event.error);
    };
    engine.onend = () => {
      recognition = null;
      if (wanted && continuous) start();
      else setState('idle');
    };
    return engine;
  }

  function start() {
    if (!RecognitionImpl) return onError('This browser has no speech recognition — try Whisper');
    wanted = true;
    if (recognition) return;
    recognition = build();
    try {
      recognition.start();
    } catch {
      /* already started */
    }
  }

  function stop() {
    wanted = false;
    if (!recognition) return setState('idle');
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }

  function abort() {
    wanted = false;
    if (!recognition) return setState('idle');
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
  }

  return {
    engine: 'webspeech',
    start,
    stop,
    abort,
    close: abort,
    get state() {
      return state;
    },
  };
}

// ---- Whisper, on this machine ----

function createWhisperInput(options = {}) {
  return createWhisperRecogniser(options);
}

// ---- the door ----

export function createSpeechInput({ engine = 'webspeech', ...options } = {}) {
  return engine === 'whisper' ? createWhisperInput(options) : createWebSpeechInput(options);
}

export { createWebSpeechInput, createWhisperInput };
