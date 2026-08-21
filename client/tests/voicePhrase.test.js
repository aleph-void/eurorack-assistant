import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// Both recognisers are replaced, because the point of this file is which one
// the panel opens when — Whisper listening to the room for the key phrase, and
// the browser's own recogniser opened only once the phrase has been heard.
let built = [];
vi.mock('../src/speechInput.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSpeechInput: (options = {}) => {
      const input = {
        options,
        started: 0,
        stopped: 0,
        closed: 0,
        state: 'idle',
        start() {
          this.started += 1;
          options.onState?.('listening');
        },
        stop() {
          this.stopped += 1;
          options.onState?.('idle');
        },
        abort() {},
        close() {
          this.closed += 1;
        },
        say(transcript, alternatives) {
          options.onResult?.({
            transcript,
            alternatives: alternatives || [{ transcript, confidence: 0.9 }],
          });
        },
      };
      built.push(input);
      return input;
    },
  };
});

import { api } from '../src/api.js';
import VoicePatchPanel from '../src/components/VoicePatchPanel.vue';
import { loadVoiceSettings, resetVoiceSettings } from '../src/voiceSettings.js';
import { clearVoicePatch, setVoicePatch, voiceTarget } from '../src/voicePatchTarget.js';

const ofEngine = (engine) => built.filter((i) => i.options.engine === engine).at(-1);
// The room, heard by Whisper; and the cable, heard by the browser.
const listener = () => ofEngine('whisper');
const commandInput = () => ofEngine('webspeech');

const jack = (moduleId, label, name, id, index) => ({
  patch_module_id: moduleId,
  component_id: id,
  module_label: label,
  jack_name: name,
  jack_index: index,
  disabled: false,
});
const fromCandidates = [jack(1, 'Make Noise Maths', 'EOR', 11, 1)];
const toCandidates = [jack(2, '2hp Div', 'Clock', 21, 1), jack(2, '2hp Div', 'Reset', 22, 2)];
const cableCandidates = [
  { cable_id: 9, module_label: 'Make Noise Maths EOR', jack_name: '2hp Div Clock' },
];

async function open(settings = {}) {
  localStorage.setItem(
    'eurorack-assistant.voice',
    JSON.stringify({ enabled: true, mode: 'phrase', engine: 'webspeech', ...settings })
  );
  loadVoiceSettings(null, { force: true });
  // The listener is mounted over the whole app and takes its patch from
  // whichever diagram is on screen (voicePatchTarget.js).
  setVoicePatch('7', {
    label: 'Krell',
    from: () => fromCandidates,
    to: () => toCandidates,
    cables: () => cableCandidates,
    vocabulary: () => [],
  });
  const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
  await flushPromises();
  return wrapper;
}

// The settings and the patch on screen are one object for the whole app, so
// a listener left mounted by a finished test would react to the next test's
// setup and open a second microphone.
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  built = [];
  localStorage.clear();
  clearVoicePatch(voiceTarget.claim);
  resetVoiceSettings();
  window.SpeechRecognition = class {};
  window.AudioContext = undefined;
  window.speechSynthesis = undefined;
});
afterEach(() => {
  delete window.SpeechRecognition;
});

describe('the key phrase mode', () => {
  it('listens to the room with Whisper and leaves the browser closed until it hears the phrase', async () => {
    const wrapper = await open();
    // Whisper is what listens all evening, whatever the command recogniser is
    // set to: the room is transcribed on this machine and nowhere else.
    expect(listener().options.engine).toBe('whisper');
    expect(listener().started).toBe(1);
    expect(commandInput().started).toBe(0);
    expect(wrapper.find('[data-test="voice-status"]').text()).toContain('create connection between');
  });

  it('says nothing to the room it is only overhearing', async () => {
    const wrapper = await open();
    listener().say('that filter is doing something odd');
    await flushPromises();
    expect(commandInput().started).toBe(0);
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="voice-status"]').text()).toContain('Waiting');
  });

  it('opens the browser’s recogniser on the phrase and plugs what it then hears', async () => {
    api.post.mockResolvedValue({ id: 44 });
    const wrapper = await open();

    listener().say('create connection between');
    await flushPromises();
    expect(commandInput().started).toBe(1);
    expect(listener().stopped).toBe(1);
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Say the cable…');

    commandInput().say('maths e o r and 2hp div clock');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 1,
      from_component_id: 11,
      to_patch_module_id: 2,
      to_component_id: 21,
      stacked: undefined,
      optional: undefined,
    });
    // And the room is listened to again for the next one.
    expect(listener().started).toBe(2);
  });

  it('pulls a cable out when the phrase said so', async () => {
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = await open();

    listener().say('disconnect connection between');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Which cable?');

    commandInput().say('maths e o r and 2hp div clock');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/9');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('reads a cable said in the same breath as the phrase, which is how it is said', async () => {
    vi.useFakeTimers();
    try {
      api.post.mockResolvedValue({ id: 45 });
      const wrapper = await open();
      listener().say('create connection between maths e o r and 2hp div reset');
      // The browser's recogniser is opened and given its moment first — it
      // never heard those words, so what Whisper heard is the command.
      expect(api.post).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.post).toHaveBeenCalledWith(
        '/api/patches/7/cables',
        expect.objectContaining({ from_component_id: 11, to_component_id: 22 })
      );
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // The phrase itself is typed on the settings page; what this file is about
  // is that the listener answers to whatever it has been set to.
  it('takes the phrases the rack owner would rather say', async () => {
    api.post.mockResolvedValue({ id: 46 });
    await open({ connectPhrase: 'wire up' });

    // Not the default phrase any more: the room says the new one.
    listener().say('create connection between');
    await flushPromises();
    expect(commandInput().started).toBe(0);

    listener().say('wire up');
    await flushPromises();
    commandInput().say('maths e o r and 2hp div clock');
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('gives both microphones back when the page is left', async () => {
    const wrapper = await open();
    const [command, room] = [commandInput(), listener()];
    wrapper.unmount();
    expect(command.closed).toBe(1);
    expect(room.closed).toBe(1);
  });
});
