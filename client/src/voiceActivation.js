// Deciding when the app is being spoken to.
//
// A studio is the worst room in the house for this. The rack is making noise,
// there is usually music playing, and both of your hands are holding a cable.
// No single answer fits everybody, so all four live here and the choice is the
// rack owner's:
//
//   push to talk  hold a key while you speak. Nothing else can trigger it.
//   toggle        one click opens a session; speak as many cables as you like.
//   wake word     always listening, acts only after "patch:" or "hey rack".
//   MIDI          a footswitch on the desk arms the mic. Both hands stay free.
//
// The layer knows nothing about cables — it starts and stops a speech
// controller, and for the wake word it says where the command begins.

import { speechWords, wordScore } from './voiceGrammar.js';

export const ACTIVATION_MODES = Object.freeze([
  { value: 'ptt', label: 'Push to talk — hold a key', continuous: false },
  { value: 'toggle', label: 'Patch mode — click to start a session', continuous: true },
  { value: 'wake', label: 'Wake word — always listening', continuous: true },
  { value: 'midi', label: 'MIDI / footswitch', continuous: false },
]);

export const isContinuous = (mode) =>
  Boolean(ACTIVATION_MODES.find((m) => m.value === mode)?.continuous);

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const isTyping = (element) =>
  Boolean(element) && (TYPING.has(element.tagName) || element.isContentEditable);

// ---- wake words ----

// Fuzzy, because a recogniser that has never heard of a eurorack will not hear
// "hey rack" cleanly either. Returns what was said after the wake word, '' when
// the wake word was the whole utterance, and null when it was not there.
export function afterWakeWord(transcript, wakeWords = ['patch', 'hey rack']) {
  const raw = String(transcript ?? '').trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return null;
  // Compared word by word rather than as one normalised string, so that what
  // is handed on is the sentence as it was actually said — the parser has its
  // own opinions about spelling and does better starting from the original.
  const spoken = raw.map((word) => speechWords(word).join(' '));
  for (const phrase of wakeWords) {
    const wake = speechWords(phrase);
    if (!wake.length || wake.length > spoken.length) continue;
    // A wake word is only a wake word at the top of the sentence — otherwise
    // "unplug the patch cable" wakes it up halfway through.
    const hit = wake.every((word, i) => wordScore(spoken[i], word) >= 0.78);
    if (hit) return raw.slice(wake.length).join(' ');
  }
  return null;
}

// ---- the switch ----

export function createVoiceActivation({
  mode = 'ptt',
  input,
  key = 'Space',
  wakeWords = ['patch', 'hey rack'],
  binding = null, // { type: 'note' | 'cc', number, channel }
  onArm = () => {},
  onDisarm = () => {},
  onBinding = () => {},
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
    // Always-listening modes have nothing to wait for.
    if (mode === 'wake') arm();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    learning = false;
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

  return {
    mode,
    attach,
    detach,
    // For the on-screen button, which behaves like the key in every mode.
    press: arm,
    release: disarm,
    toggle,
    async learnBinding() {
      if (!(await openMidi())) return;
      learning = true;
    },
    stopLearning() {
      learning = false;
    },
    commandFrom: (transcript) => (mode === 'wake' ? afterWakeWord(transcript, wakeWords) : transcript),
    get binding() {
      return currentBinding;
    },
    get learning() {
      return learning;
    },
    get armed() {
      return armed;
    },
  };
}
