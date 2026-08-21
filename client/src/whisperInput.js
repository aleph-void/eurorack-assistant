// Whisper, running on your own machine.
//
// The microphone is read as raw samples rather than through MediaRecorder,
// because the same numbers that get resampled down to the 16 kHz Whisper wants
// also give the loudness meter, and the loudness meter is what decides where
// one spoken command ends and the next begins. In a room with a modular synth
// in it that second job matters as much as the first.
//
// The model itself never runs here — it goes to a worker, so a two second
// transcription does not freeze the button you just let go of. The worker is
// injectable, and so is `transcribe`, so tests do all of this without a
// microphone or a 40 MB download.

import { microphoneConstraints } from './audioDevices.js';

export const WHISPER_MODELS = Object.freeze([
  { value: 'Xenova/whisper-tiny.en', label: 'Tiny (English) — ~40 MB, fastest' },
  { value: 'Xenova/whisper-base.en', label: 'Base (English) — ~150 MB, more accurate' },
  { value: 'Xenova/whisper-small.en', label: 'Small (English) — ~480 MB, most accurate' },
]);

const TARGET_RATE = 16000;

// Box-average down to 16 kHz. Averaging over the whole source interval rather
// than picking one sample out of it is a crude low-pass, which is what keeps
// the top of a 48 kHz recording from folding back down into the speech.
export function resampleTo16k(samples, sourceRate) {
  if (!sourceRate || sourceRate === TARGET_RATE) return samples;
  const ratio = sourceRate / TARGET_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export const rms = (buffer) => {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / (buffer.length || 1));
};

// A patch bay is never silent, so "quiet" is whatever this room has been doing
// lately rather than a number picked in advance. The floor tracks downwards
// quickly and upwards slowly, so a held chord raises it and a pause lowers it.
export function createLevelGate({ silenceMs = 700, minSpeechMs = 250, marginDb = 9 } = {}) {
  let floor = 0.005;
  let speaking = false;
  let speechMs = 0;
  let quietMs = 0;
  const margin = 10 ** (marginDb / 20);

  return {
    get floor() {
      return floor;
    },
    // Returns 'start', 'end' or null for this block of audio.
    push(level, blockMs) {
      floor = level < floor ? floor * 0.7 + level * 0.3 : floor * 0.995 + level * 0.005;
      const loud = level > Math.max(floor * margin, 0.008);
      if (loud) {
        quietMs = 0;
        speechMs += blockMs;
        if (!speaking && speechMs >= minSpeechMs) {
          speaking = true;
          return 'start';
        }
        return null;
      }
      speechMs = speaking ? speechMs : 0;
      if (!speaking) return null;
      quietMs += blockMs;
      if (quietMs >= silenceMs) {
        speaking = false;
        speechMs = 0;
        quietMs = 0;
        return 'end';
      }
      return null;
    },
    reset() {
      speaking = false;
      speechMs = 0;
      quietMs = 0;
    },
  };
}

// The default worker: only built when a real transcription is actually wanted,
// so that importing this module costs nothing and jsdom never sees a Worker.
function defaultTranscriber({ model, createWorker }) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  const ensure = async () => {
    if (worker) return worker;
    const make = createWorker || (await import('./whisperWorkerFactory.js')).createWhisperWorker;
    worker = make();
    worker.onmessage = ({ data }) => {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.text || '');
    };
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error('Whisper worker failed to start'));
      pending.clear();
    };
    return worker;
  };

  return {
    async run(samples) {
      const id = nextId;
      nextId += 1;
      const target = await ensure();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ id, model, samples }, [samples.buffer]);
      });
    },
    close() {
      if (worker) worker.terminate();
      worker = null;
      pending.clear();
    },
  };
}

export function createWhisperRecogniser({
  continuous = false,
  model = 'Xenova/whisper-tiny.en',
  deviceId = '',
  blockSize = 4096,
  maxUtteranceMs = 15000,
  onPartial = () => {},
  onResult = () => {},
  onError = () => {},
  onState = () => {},
  onLevel = null,
  mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
  AudioContextImpl = typeof window !== 'undefined'
    ? window.AudioContext || window.webkitAudioContext
    : null,
  transcribe = null,
  createWorker = null,
  gateOptions = {},
} = {}) {
  let context = null;
  let stream = null;
  let node = null;
  let source = null;
  let wanted = false;
  let capturing = false;
  let state = 'idle';
  let chunks = [];
  let captured = 0;
  const gate = createLevelGate(gateOptions);
  const transcriber = transcribe
    ? { run: transcribe, close() {} }
    : defaultTranscriber({ model, createWorker });

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  function collect(block) {
    chunks.push(Float32Array.from(block));
    captured += block.length;
  }

  // Takes the blocks it was handed rather than reading them off the recorder,
  // so the next thing you say can start recording while the last one is still
  // being transcribed.
  async function flush(blocks) {
    const rate = context?.sampleRate || TARGET_RATE;
    const total = blocks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const chunk of blocks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const samples = resampleTo16k(joined, rate);
    if (!transcriber) return onError('Whisper needs a Worker — this browser has none');
    setState('thinking');
    try {
      const text = String((await transcriber.run(samples)) || '').trim();
      if (text) onResult({ transcript: text, alternatives: [{ transcript: text, confidence: 1 }] });
    } catch (e) {
      onError(e?.message || 'Whisper could not transcribe that');
    } finally {
      setState(wanted ? 'listening' : 'idle');
    }
  }

  function finish() {
    const blocks = chunks;
    const rate = context?.sampleRate || TARGET_RATE;
    const total = blocks.reduce((n, c) => n + c.length, 0);
    chunks = [];
    captured = 0;
    // A tap on the button rather than a held press. Nothing to transcribe, but
    // the state still has to come back — otherwise the panel says it is
    // listening when it is not.
    if (total < rate * 0.2) {
      setState(wanted ? 'listening' : 'idle');
      return undefined;
    }
    return flush(blocks);
  }

  function onAudio(event) {
    // The microphone node stays connected between commands, so "stopped" has
    // to be checked here rather than assumed: without this, leaving patch mode
    // leaves the room being transcribed.
    if (!wanted) return;
    const block = event.inputBuffer.getChannelData(0);
    const blockMs = (block.length / (context.sampleRate || TARGET_RATE)) * 1000;
    const level = rms(block);
    if (onLevel) onLevel(level);

    if (!continuous) {
      if (capturing) collect(block);
      return;
    }
    const edge = gate.push(level, blockMs);
    if (edge === 'start') {
      capturing = true;
      onPartial('…');
    }
    if (capturing) collect(block);
    const tooLong = captured / (context.sampleRate || TARGET_RATE) > maxUtteranceMs / 1000;
    if (capturing && (edge === 'end' || tooLong)) {
      capturing = false;
      gate.reset();
      finish();
    }
  }

  async function open() {
    if (context) return true;
    if (!mediaDevices?.getUserMedia || !AudioContextImpl) {
      onError('This browser cannot record audio');
      return false;
    }
    try {
      stream = await mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId) });
    } catch (e) {
      // A chosen microphone is asked for exactly, so that a device unplugged
      // since it was picked is refused rather than silently swapped for the
      // one pointed at the rack. Refused is not the same as forbidden, though:
      // fall back to the default microphone and say which one is being used.
      if (deviceId && e?.name === 'OverconstrainedError') {
        onError('That microphone is gone — using the default one instead');
        try {
          stream = await mediaDevices.getUserMedia({ audio: microphoneConstraints('') });
        } catch {
          onError('Microphone permission was refused');
          return false;
        }
      } else {
        onError('Microphone permission was refused');
        return false;
      }
    }
    context = new AudioContextImpl();
    source = context.createMediaStreamSource(stream);
    node = context.createScriptProcessor(blockSize, 1, 1);
    node.onaudioprocess = onAudio;
    source.connect(node);
    // Chrome will not run a ScriptProcessor that goes nowhere, and a zero gain
    // is what stops the room being fed back into itself.
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(context.destination);
    return true;
  }

  async function start() {
    wanted = true;
    if (!(await open())) {
      wanted = false;
      return;
    }
    if (context.state === 'suspended') await context.resume();
    gate.reset();
    chunks = [];
    captured = 0;
    capturing = !continuous;
    setState('listening');
  }

  function stop() {
    wanted = false;
    if (!continuous && capturing) {
      capturing = false;
      finish();
    } else {
      capturing = false;
      setState(state === 'thinking' ? 'thinking' : 'idle');
    }
  }

  function abort() {
    wanted = false;
    capturing = false;
    chunks = [];
    captured = 0;
    gate.reset();
    setState('idle');
  }

  function close() {
    abort();
    if (node) node.onaudioprocess = null;
    try {
      source?.disconnect();
      node?.disconnect();
    } catch {
      /* already torn down */
    }
    stream?.getTracks?.().forEach((track) => track.stop());
    context?.close?.();
    transcriber?.close?.();
    context = null;
    stream = null;
    node = null;
    source = null;
  }

  return {
    engine: 'whisper',
    start,
    stop,
    abort,
    close,
    get state() {
      return state;
    },
  };
}
