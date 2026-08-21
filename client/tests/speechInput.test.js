import { describe, it, expect, vi } from 'vitest';
import { createSpeechInput, engineAvailability, ENGINE_UNUSABLE } from '../src/speechInput.js';
import { createWhisperRecogniser, resampleTo16k, rms, createLevelGate } from '../src/whisperInput.js';

// ---- a recogniser that never hears anything ----

function fakeRecognition() {
  const made = [];
  class FakeRecognition {
    constructor() {
      this.started = 0;
      this.stopped = 0;
      this.aborted = 0;
      made.push(this);
    }
    start() {
      this.started += 1;
      this.onstart?.();
    }
    stop() {
      this.stopped += 1;
      this.onend?.();
    }
    abort() {
      this.aborted += 1;
      this.onend?.();
    }
    // What Chrome hands over: an array-like of results, each an array-like of
    // readings, with isFinal on the result rather than the reading.
    say(alternatives, isFinal = true) {
      const result = Object.assign([...alternatives], { isFinal });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
  }
  return { FakeRecognition, made };
}

describe('the browser recogniser', () => {
  it('hands over every reading of a final result', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const onResult = vi.fn();
    const input = createSpeechInput({ RecognitionImpl: FakeRecognition, onResult });
    input.start();
    made[0].say([
      { transcript: 'connect maths to div', confidence: 0.9 },
      { transcript: 'connect mats to dave', confidence: 0.4 },
    ]);
    expect(onResult).toHaveBeenCalledWith({
      transcript: 'connect maths to div',
      alternatives: [
        { transcript: 'connect maths to div', confidence: 0.9 },
        { transcript: 'connect mats to dave', confidence: 0.4 },
      ],
    });
  });

  it('is handed the input device and cannot use it', () => {
    const { FakeRecognition } = fakeRecognition();
    // Web Speech opens the system default microphone itself. The option is
    // taken and ignored so that the panel can hold one setting for both
    // engines; what must not happen is a refusal to build.
    expect(() =>
      createSpeechInput({ RecognitionImpl: FakeRecognition, deviceId: 'mic-1' }).start()
    ).not.toThrow();
  });

  it('reports what is still being said separately', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const onPartial = vi.fn();
    const onResult = vi.fn();
    createSpeechInput({ RecognitionImpl: FakeRecognition, onPartial, onResult }).start();
    made[0].say([{ transcript: 'connect ma', confidence: 0 }], false);
    expect(onPartial).toHaveBeenCalledWith('connect ma');
    expect(onResult).not.toHaveBeenCalled();
  });

  it('keeps a session open when the recogniser gives up mid-session', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const input = createSpeechInput({ RecognitionImpl: FakeRecognition, continuous: true });
    input.start();
    made[0].onend();
    expect(made).toHaveLength(2);
    input.stop();
    expect(made).toHaveLength(2);
  });

  it('says nothing about a held button nobody spoke into', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const onError = vi.fn();
    createSpeechInput({ RecognitionImpl: FakeRecognition, onError }).start();
    made[0].onerror({ error: 'no-speech' });
    made[0].onerror({ error: 'aborted' });
    expect(onError).not.toHaveBeenCalled();
    made[0].onerror({ error: 'not-allowed' });
    expect(onError).toHaveBeenCalledWith('Microphone permission was refused', 'not-allowed');
  });

  // Chrome's recogniser is not on this machine: it streams the audio to
  // Google, and a Chromium built without a key for that service fails this
  // way every single time. Saying "network" alone reads as a flaky connection
  // and sends people looking in the wrong place.
  it('explains a recogniser whose service is out of reach, and says to use Whisper', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const onError = vi.fn();
    createSpeechInput({ RecognitionImpl: FakeRecognition, onError }).start();

    made[0].onerror({ error: 'network' });
    const [said, code] = onError.mock.calls[0];
    expect(said).toContain('could not reach its speech service');
    expect(said).toContain('Local Whisper');
    // The code rides along so the panel can offer the way out.
    expect(code).toBe('network');
    expect(ENGINE_UNUSABLE).toContain('network');
    expect(ENGINE_UNUSABLE).toContain('service-not-allowed');
  });

  it('still passes an error it has no better words for through', () => {
    const { FakeRecognition, made } = fakeRecognition();
    const onError = vi.fn();
    createSpeechInput({ RecognitionImpl: FakeRecognition, onError }).start();
    made[0].onerror({ error: 'bad-grammar' });
    expect(onError).toHaveBeenCalledWith(
      'Speech recognition failed (bad-grammar)',
      'bad-grammar'
    );
  });

  it('says so when the browser has no recogniser at all', () => {
    const onError = vi.fn();
    createSpeechInput({ RecognitionImpl: null, onError }).start();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/no speech recognition/));
  });

  it('reports which engines this browser can run', () => {
    expect(engineAvailability({ RecognitionImpl: null, mediaDevices: null })).toEqual({
      webspeech: false,
      whisper: false,
    });
    expect(
      engineAvailability({ RecognitionImpl: class {}, mediaDevices: { getUserMedia() {} } })
    ).toEqual({ webspeech: true, whisper: true });
  });
});

// ---- Whisper, without a microphone ----

function fakeAudio({ sampleRate = 48000 } = {}) {
  const processors = [];
  class FakeAudioContext {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.closed = false;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const node = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(node);
      return node;
    }
    createGain() {
      return { gain: {}, connect() {}, disconnect() {} };
    }
    resume() {}
    close() {
      this.closed = true;
    }
  }
  const stopped = [];
  const mediaDevices = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] })),
  };
  const block = (value, length = 4096) =>
    ({ inputBuffer: { getChannelData: () => new Float32Array(length).fill(value) } });
  return { FakeAudioContext, processors, mediaDevices, stopped, block };
}

describe('Whisper on this machine', () => {
  it('records while the button is held and transcribes what it got', async () => {
    const { FakeAudioContext, processors, mediaDevices, block } = fakeAudio();
    const transcribe = vi.fn(async () => 'connect maths eor to div clock');
    const onResult = vi.fn();
    const input = createWhisperRecogniser({
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe,
      onResult,
    });
    await input.start();
    for (let i = 0; i < 20; i += 1) processors[0].onaudioprocess(block(0.2));
    await input.stop();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult.mock.calls[0][0].transcript).toBe('connect maths eor to div clock');
    // Whatever the microphone runs at, Whisper is handed 16 kHz.
    expect(transcribe.mock.calls[0][0].length).toBe(Math.floor((20 * 4096) / 3));
  });

  it('throws away a click too short to be a sentence', async () => {
    const { FakeAudioContext, processors, mediaDevices, block } = fakeAudio();
    const transcribe = vi.fn(async () => 'nope');
    const input = createWhisperRecogniser({
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe,
    });
    await input.start();
    processors[0].onaudioprocess(block(0.2));
    await input.stop();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('says so when the microphone is refused', async () => {
    const { FakeAudioContext } = fakeAudio();
    const onError = vi.fn();
    const input = createWhisperRecogniser({
      mediaDevices: { getUserMedia: async () => Promise.reject(new Error('no')) },
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => '',
      onError,
    });
    await input.start();
    expect(onError).toHaveBeenCalledWith('Microphone permission was refused');
  });

  it('asks for the chosen microphone exactly', async () => {
    const { FakeAudioContext, mediaDevices } = fakeAudio();
    const input = createWhisperRecogniser({
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => '',
      deviceId: 'mic-1',
    });
    await input.start();
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'mic-1' } }),
    });
  });

  // A microphone unplugged since it was chosen is refused outright by `exact`,
  // and a refused microphone reads as "permission denied" to everybody looking
  // at it. Falling back keeps voice working; saying so keeps it honest.
  it('falls back to the default microphone when the chosen one has gone', async () => {
    const { FakeAudioContext } = fakeAudio();
    const onError = vi.fn();
    const getUserMedia = vi.fn(async ({ audio }) => {
      if (audio.deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      return { getTracks: () => [] };
    });
    const input = createWhisperRecogniser({
      mediaDevices: { getUserMedia },
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => '',
      deviceId: 'mic-gone',
      onError,
    });
    await input.start();
    expect(onError).toHaveBeenCalledWith('That microphone is gone — using the default one instead');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(input.state).toBe('listening');
  });

  it('lets go of the microphone when it is closed', async () => {
    const { FakeAudioContext, mediaDevices, stopped } = fakeAudio();
    const input = createWhisperRecogniser({
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => '',
    });
    await input.start();
    input.close();
    expect(stopped).toHaveLength(1);
  });

  it('stops transcribing the room the moment the session is closed', async () => {
    const { FakeAudioContext, processors, mediaDevices, block } = fakeAudio();
    const onResult = vi.fn();
    const input = createWhisperRecogniser({
      continuous: true,
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => 'connect maths eor to div clock',
      onResult,
    });
    await input.start();
    const speak = () => {
      for (let i = 0; i < 20; i += 1) processors[0].onaudioprocess(block(0.3));
    };
    const silence = () => {
      for (let i = 0; i < 20; i += 1) processors[0].onaudioprocess(block(0.00001));
    };
    speak();
    silence();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    // Patch mode is closed, and the conversation in the room carries on.
    input.stop();
    speak();
    silence();
    speak();
    silence();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('comes back to idle after a tap too short to have said anything', async () => {
    const { FakeAudioContext, processors, mediaDevices, block } = fakeAudio();
    const input = createWhisperRecogniser({
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe: async () => 'hello',
    });
    await input.start();
    processors[0].onaudioprocess(block(0.2));
    await input.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(input.state).toBe('idle');
  });

  it('cuts a continuous session into utterances at the silences', async () => {
    const { FakeAudioContext, processors, mediaDevices, block } = fakeAudio();
    const transcribe = vi.fn(async () => 'connect maths eor to div clock');
    const onResult = vi.fn();
    const input = createWhisperRecogniser({
      continuous: true,
      mediaDevices,
      AudioContextImpl: FakeAudioContext,
      transcribe,
      onResult,
    });
    await input.start();
    for (let i = 0; i < 30; i += 1) processors[0].onaudioprocess(block(0.3));
    for (let i = 0; i < 30; i += 1) processors[0].onaudioprocess(block(0.00001));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
  });
});

describe('the audio underneath', () => {
  it('averages down to 16 kHz rather than throwing samples away', () => {
    const source = Float32Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const out = resampleTo16k(source, 48000);
    expect(out).toHaveLength(16);
    expect(out[0]).toBeCloseTo(1 / 3, 5);
  });

  it('leaves audio that is already 16 kHz alone', () => {
    const source = new Float32Array([1, 2, 3]);
    expect(resampleTo16k(source, 16000)).toBe(source);
  });

  it('measures loudness', () => {
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rms(new Float32Array(8))).toBe(0);
  });

  it('opens on speech and closes after the silence, not before', () => {
    const gate = createLevelGate({ silenceMs: 300, minSpeechMs: 100 });
    expect(gate.push(0.4, 60)).toBeNull();
    expect(gate.push(0.4, 60)).toBe('start');
    expect(gate.push(0.0000001, 100)).toBeNull();
    expect(gate.push(0.0000001, 100)).toBeNull();
    expect(gate.push(0.0000001, 100)).toBe('end');
  });

  it('is not opened by a room that is merely loud', () => {
    const gate = createLevelGate({ minSpeechMs: 100 });
    for (let i = 0; i < 200; i += 1) gate.push(0.05, 60);
    expect(gate.push(0.05, 60)).toBeNull();
  });
});
