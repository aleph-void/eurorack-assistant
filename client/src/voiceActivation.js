// Deciding when the app is being spoken to.
//
// A studio is the worst room in the house for this. The rack is making noise,
// there is usually music playing, and both of your hands are holding a cable.
// No single answer fits everybody, so all five live here and the choice is the
// rack owner's:
//
//   push to talk  hold a key while you speak. Nothing else can trigger it.
//   toggle        one click opens a session; speak as many cables as you like.
//   wake word     always listening, acts only after "patch:" or "hey rack".
//   key phrase    Whisper listens for "create connection between", and the
//                 browser's recogniser takes the cable that follows it.
//   MIDI          a footswitch on the desk arms the mic. Both hands stay free.
//
// The layer knows nothing about cables — it starts and stops a speech
// controller, and for the wake word and the key phrase it says where the
// command begins and what kind of command it is.

import { speechWords, wordScore } from './voiceGrammar.js';

export const ACTIVATION_MODES = Object.freeze([
  { value: 'ptt', label: 'Push to talk — hold a key', continuous: false },
  { value: 'toggle', label: 'Patch mode — click to start a session', continuous: true },
  { value: 'wake', label: 'Wake word — always listening', continuous: true },
  { value: 'phrase', label: 'Key phrase — Whisper listens, then transcribes', continuous: false },
  { value: 'midi', label: 'MIDI / footswitch', continuous: false },
]);

// What each phrase means, spelled as the word the parser reads an intent from
// (voiceCommand.js). "create connection between maths out and div clock" is
// therefore parsed as "connect maths out and div clock".
export const PHRASE_INTENTS = Object.freeze({ connect: 'connect', disconnect: 'disconnect' });

export const DEFAULT_KEY_PHRASES = Object.freeze([
  { phrase: 'create connection between', intent: 'connect' },
  { phrase: 'disconnect connection between', intent: 'disconnect' },
]);

export const isContinuous = (mode) =>
  Boolean(ACTIVATION_MODES.find((m) => m.value === mode)?.continuous);

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const isTyping = (element) =>
  Boolean(element) && (TYPING.has(element.tagName) || element.isContentEditable);

// ---- wake words and key phrases ----

const PHRASE_MATCH = 0.78;

// Fuzzy, because a recogniser that has never heard of a eurorack will not hear
// "hey rack" cleanly either. Returns which phrase was heard and what was said
// after it — '' when the phrase was the whole utterance — or null when none of
// them was there.
//
// `anywhere` is the difference between a wake word and a key phrase. One word
// ("patch") is only a wake word at the top of the sentence, or "unplug the
// patch cable" wakes it up halfway through; a deliberate three-word phrase
// ("create connection between") is unmistakable wherever it lands, and people
// lead into it — "okay, create connection between…".
export function matchKeyPhrase(transcript, phrases = DEFAULT_KEY_PHRASES, { anywhere = true } = {}) {
  const raw = String(transcript ?? '').trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return null;
  // Compared word by word rather than as one normalised string, so that what
  // is handed on is the sentence as it was actually said — the parser has its
  // own opinions about spelling and does better starting from the original.
  const spoken = raw.map((word) => speechWords(word).join(' '));
  // Longest first: "disconnect connection between" and "create connection
  // between" share two of their three words, and the one that explains more of
  // what was said is the one that was meant.
  const wanted = phrases
    .map((entry) => (typeof entry === 'string' ? { phrase: entry, intent: 'connect' } : entry))
    .map((entry) => ({ ...entry, words: speechWords(entry.phrase || '') }))
    .filter((entry) => entry.words.length)
    .sort((a, b) => b.words.length - a.words.length);
  const last = anywhere ? spoken.length - 1 : 0;
  for (let offset = 0; offset <= last; offset += 1) {
    for (const entry of wanted) {
      if (offset + entry.words.length > spoken.length) continue;
      const hit = entry.words.every(
        (word, i) => wordScore(spoken[offset + i], word) >= PHRASE_MATCH
      );
      if (hit)
        return {
          phrase: entry.phrase,
          intent: entry.intent || 'connect',
          rest: raw.slice(offset + entry.words.length).join(' '),
        };
    }
  }
  return null;
}

// What was said after the wake word, '' when the wake word was the whole
// utterance, and null when it was not there.
export function afterWakeWord(transcript, wakeWords = ['patch', 'hey rack']) {
  return matchKeyPhrase(transcript, wakeWords, { anywhere: false })?.rest ?? null;
}

// ---- the switch ----

export function createVoiceActivation({
  mode = 'ptt',
  input,
  key = 'Space',
  wakeWords = ['patch', 'hey rack'],
  keyPhrases = DEFAULT_KEY_PHRASES,
  // Builds the always-listening recogniser that the key phrase is looked for
  // in — Whisper, so that a room being listened to all evening is transcribed
  // on this machine and nowhere else. Given by the caller, because building a
  // recogniser is the panel's job and knowing when to act is this layer's.
  createPhraseInput = null,
  // How long the command recogniser stays open after the phrase with nothing
  // said into it, and how long it is given before what Whisper already heard
  // in the same breath is used instead.
  commandWindowMs = 8000,
  fallbackMs = 2500,
  binding = null, // { type: 'note' | 'cc', number, channel }
  onArm = () => {},
  onDisarm = () => {},
  onBinding = () => {},
  onPhrase = () => {},
  onCommand = () => {},
  onError = () => {},
  target = typeof window !== 'undefined' ? window : null,
  requestMIDIAccess = typeof navigator !== 'undefined' && navigator.requestMIDIAccess
    ? navigator.requestMIDIAccess.bind(navigator)
    : null,
} = {}) {
  let armed = false;
  let attached = false;
  let learning = false;
  let midiAccess = null;
  let currentBinding = binding;
  let phraseInput = null;
  let turn = null; // { intent, rest, heard } — the key phrase currently being answered
  let windowTimer = null;
  let fallbackTimer = null;

  function arm() {
    if (armed) return;
    armed = true;
    onArm();
    input?.start();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    onDisarm();
    input?.stop();
  }

  const toggle = () => (armed ? disarm() : arm());

  // ---- the key phrase ----

  // The sentence the parser reads: the phrase said what kind of cable this is,
  // and the verb is how that is carried into voiceCommand.js.
  const asCommand = (intent, text) => `${PHRASE_INTENTS[intent] || 'connect'} ${text}`.trim();

  function clearTimers() {
    if (windowTimer) clearTimeout(windowTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    windowTimer = null;
    fallbackTimer = null;
  }

  // Done with this phrase, however it ended. The command recogniser closes and
  // the room goes back to being listened to for the phrase — one microphone's
  // worth of transcription at a time, because Whisper is not free.
  function endTurn() {
    clearTimers();
    turn = null;
    disarm();
    if (attached && mode === 'phrase') phraseInput?.start();
  }

  // Said in one breath — "create connection between maths out and div clock".
  // The command recogniser was not open yet when those words were spoken, so
  // it will hear nothing; what Whisper already transcribed is the command, and
  // it is used once the recogniser has been given its moment to disagree.
  function useHeardRest() {
    if (!turn || turn.heard) return;
    const { intent, rest } = turn;
    endTurn();
    const text = asCommand(intent, rest);
    onCommand(text, [{ transcript: text, confidence: 1 }]);
  }

  function beginTurn(intent, rest = '') {
    clearTimers();
    turn = { intent, rest, heard: false };
    onPhrase(intent, rest);
    phraseInput?.stop();
    arm();
    if (rest) fallbackTimer = setTimeout(useHeardRest, fallbackMs);
    windowTimer = setTimeout(endTurn, commandWindowMs);
  }

  function onPhraseResult({ transcript }) {
    // Mid-command: the phrase listener is stopped, but a transcription started
    // before it was stopped still lands here.
    if (turn) return;
    const hit = matchKeyPhrase(transcript, keyPhrases);
    if (hit) beginTurn(hit.intent, hit.rest);
  }

  function openPhraseInput() {
    if (phraseInput || !createPhraseInput) return;
    phraseInput = createPhraseInput({
      continuous: true,
      onResult: onPhraseResult,
      onError: (text) => onError(text),
    });
    phraseInput?.start();
  }

  // ---- what counts as a command ----

  // Every reading of one breath, turned into the readings the parser should be
  // given — or null when this utterance was not addressed to the app at all.
  // The whole list is kept rather than the best one: a recogniser ranks
  // English, and the parser is the better judge of which reading names a real
  // cable (see parseBestAlternative).
  function commandFrom(transcript, alternatives = null) {
    const readings = (alternatives?.length ? alternatives : [{ transcript, confidence: 1 }]).filter(
      (reading) => String(reading?.transcript ?? '').trim()
    );
    if (mode === 'wake') {
      const rest = afterWakeWord(transcript, wakeWords);
      if (rest === null) return null;
      const woken = readings
        .map((reading) => ({
          ...reading,
          transcript: afterWakeWord(reading.transcript, wakeWords),
        }))
        .filter((reading) => reading.transcript);
      const text = rest.trim() || woken[0]?.transcript || '';
      if (!text) return null;
      return { transcript: text, alternatives: woken.length ? woken : [{ transcript: text, confidence: 1 }] };
    }
    if (mode === 'phrase') {
      // Nothing was asked for, so anything heard is the room talking.
      if (!turn || !readings.length) return null;
      turn.heard = true;
      const { intent } = turn;
      endTurn();
      return {
        transcript: asCommand(intent, transcript),
        alternatives: readings.map((reading) => ({
          ...reading,
          transcript: asCommand(intent, reading.transcript),
        })),
      };
    }
    if (!readings.length) return null;
    return { transcript, alternatives: readings };
  }

  // ---- keyboard ----

  const onKeyDown = (event) => {
    if (event.code !== key || event.repeat || isTyping(event.target)) return;
    // Space scrolls the page, and the page is long.
    event.preventDefault();
    arm();
  };
  const onKeyUp = (event) => {
    if (event.code !== key || isTyping(event.target)) return;
    event.preventDefault();
    disarm();
  };
  // A held key whose window loses focus never sends its keyup.
  const onBlur = () => disarm();

  // ---- MIDI ----

  function handleMidi(event) {
    const [status, data1, data2] = event.data || [];
    if (status === undefined) return;
    const type = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const isNoteOn = type === 0x90 && data2 > 0;
    const isNoteOff = type === 0x80 || (type === 0x90 && data2 === 0);
    const isControl = type === 0xb0;
    if (!isNoteOn && !isNoteOff && !isControl) return;

    if (learning && (isNoteOn || (isControl && data2 >= 64))) {
      currentBinding = { type: isControl ? 'cc' : 'note', number: data1, channel };
      learning = false;
      onBinding(currentBinding);
      return;
    }
    if (!currentBinding) return;
    const matches =
      currentBinding.number === data1 &&
      (currentBinding.channel == null || currentBinding.channel === channel) &&
      (currentBinding.type === 'cc') === isControl;
    if (!matches) return;
    if (isControl) return data2 >= 64 ? arm() : disarm();
    if (isNoteOn) arm();
    else disarm();
  }

  async function openMidi() {
    if (midiAccess) return true;
    if (!requestMIDIAccess) {
      onError('This browser has no Web MIDI — try push to talk');
      return false;
    }
    let access;
    try {
      access = await requestMIDIAccess({ sysex: false });
    } catch {
      onError('MIDI access was refused');
      return false;
    }
    // The browser can take a while to ask, and a setting flipped in the
    // meantime has already detached this. Wiring the port up now would leave a
    // footswitch talking to a microphone that has been closed.
    if (!attached) return false;
    midiAccess = access;
    const wire = () => {
      for (const port of midiAccess.inputs.values()) port.onmidimessage = handleMidi;
    };
    wire();
    // A footswitch plugged in after the page loaded still has to work.
    midiAccess.onstatechange = wire;
    return true;
  }

  // ---- attaching ----

  async function attach() {
    if (attached) return;
    attached = true;
    if (mode === 'ptt') {
      target?.addEventListener('keydown', onKeyDown);
      target?.addEventListener('keyup', onKeyUp);
      target?.addEventListener('blur', onBlur);
    }
    if (mode === 'midi') await openMidi();
    if (mode === 'phrase') openPhraseInput();
    // Always-listening modes have nothing to wait for.
    if (mode === 'wake') arm();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    learning = false;
    clearTimers();
    turn = null;
    // The phrase listener holds a microphone of its own, so leaving the page
    // has to give it back.
    phraseInput?.close?.();
    phraseInput = null;
    if (mode === 'ptt') {
      target?.removeEventListener('keydown', onKeyDown);
      target?.removeEventListener('keyup', onKeyUp);
      target?.removeEventListener('blur', onBlur);
    }
    if (midiAccess) {
      for (const port of midiAccess.inputs.values()) port.onmidimessage = null;
      midiAccess.onstatechange = null;
      midiAccess = null;
    }
    disarm();
  }

  // The on-screen button behaves like the key in every mode. In key-phrase
  // mode there is no phrase to take the intent from, so holding the button is
  // holding it to say a cable — the same thing the phrase itself means.
  const press = () => (mode === 'phrase' ? beginTurn('connect', '') : arm());
  const release = () => (mode === 'phrase' ? endTurn() : disarm());

  return {
    mode,
    attach,
    detach,
    press,
    release,
    toggle,
    async learnBinding() {
      if (!(await openMidi())) return;
      learning = true;
    },
    stopLearning() {
      learning = false;
    },
    commandFrom,
    get binding() {
      return currentBinding;
    },
    // What the panel says it is doing while nothing is being said to it.
    get waiting() {
      return mode === 'phrase' && !turn;
    },
    get learning() {
      return learning;
    },
    get armed() {
      return armed;
    },
  };
}
