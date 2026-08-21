import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
import { toast } from '../src/toast.js';
import VoicePatchPanel from '../src/components/VoicePatchPanel.vue';
import {
  loadVoiceSettings,
  resetVoiceSettings,
  voiceSettings,
} from '../src/voiceSettings.js';
import { clearVoicePatch, setVoicePatch, voiceTarget } from '../src/voicePatchTarget.js';

// The listener builds its own recogniser out of whatever the browser offers,
// so the browser is what the test replaces. `spoken` is the microphone.
let recognisers = [];
class FakeRecognition {
  constructor() {
    recognisers.push(this);
  }
  start() {
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
}
const spoken = (text) => {
  const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true });
  recognisers.at(-1).onresult({ resultIndex: 0, results: [result] });
};

const jack = (moduleId, label, name, id, index, disabled = false) => ({
  patch_module_id: moduleId,
  component_id: id,
  module_label: label,
  jack_name: name,
  jack_index: index,
  disabled,
});

const fromCandidates = [
  jack(1, 'Make Noise Maths', 'EOR', 11, 1),
  jack(1, 'Make Noise Maths', 'SUM', 12, 2),
  jack(1, 'Make Noise Maths', 'OR', 13, 3),
];
const toCandidates = [
  jack(2, '2hp Div', 'Clock', 21, 1),
  jack(2, '2hp Div', 'Reset', 22, 2),
];
const cableCandidates = [{ cable_id: 9, module_label: 'Make Noise Maths EOR', jack_name: '2hp Div Clock' }];

// The patch on screen. The listener is mounted over the whole app and takes
// its patch from whichever diagram registered one (voicePatchTarget.js).
let changed;
function showPatch(patchId = '7') {
  changed = vi.fn();
  return setVoicePatch(patchId, {
    label: 'Krell',
    from: () => fromCandidates,
    to: () => toCandidates,
    cables: () => cableCandidates,
    vocabulary: () => ['Maths', 'Div'],
    onChanged: changed,
  });
}

// Switched on under the account, not on the page: the bar has no toggle of
// its own, so the test sets it the way the settings page does.
function switchOn(overrides = {}) {
  Object.assign(voiceSettings, { enabled: true, engine: 'webspeech', ...overrides });
}

// Switched on, with a patch on screen, and listening. `hold` is push to talk:
// the button goes down and stays down for the length of the test. An
// always-listening mode arms itself and must not be pressed as well, or the
// microphone is opened twice.
async function open(settings = {}, { hold = true } = {}) {
  showPatch();
  switchOn(settings);
  const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
  await flushPromises();
  if (hold) {
    await wrapper.find('[data-test="voice-talk"]').trigger('pointerdown');
    await flushPromises();
  }
  return wrapper;
}

// Every setting and the patch on screen are now ONE object for the whole app
// rather than one per component, so a panel left mounted by a finished test
// reacts to the next test's setup — a second microphone opened, a settings
// page correcting an engine the other one just chose. Each test takes its
// components away with it.
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  recognisers = [];
  localStorage.clear();
  clearVoicePatch(voiceTarget.claim);
  resetVoiceSettings();
  loadVoiceSettings(null);
  window.SpeechRecognition = FakeRecognition;
  // jsdom has neither, and the listener must not need them.
  window.AudioContext = undefined;
  window.speechSynthesis = undefined;
});

describe('VoicePatchPanel', () => {
  it('draws nothing and opens no microphone until it is switched on', () => {
    showPatch();
    const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
    expect(recognisers).toHaveLength(0);
    expect(wrapper.find('[data-test="voice"]').exists()).toBe(false);
  });

  // Switched on under the account and no patch on screen: it cannot work, and
  // looking exactly like something broken is the one thing it must not do.
  it('says where it does work when it is switched on away from a patch', async () => {
    const errored = vi.spyOn(toast, 'error').mockImplementation(() => {});
    const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
    voiceSettings.enabled = true;
    await flushPromises();

    expect(recognisers).toHaveLength(0);
    expect(wrapper.find('[data-test="voice"]').exists()).toBe(false);
    expect(errored.mock.calls[0][0]).toContain('only works on the patch diagram view');
  });

  it('says it again when the key held to talk is reached for away from a patch', async () => {
    const errored = vi.spyOn(toast, 'error').mockImplementation(() => {});
    mount(VoicePatchPanel, { global: testGlobal() });
    voiceSettings.enabled = true;
    await flushPromises();
    errored.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(errored.mock.calls[0][0]).toContain('only works on the patch diagram view');
  });

  // The whole point of moving it off the patch page: open a patch and it is
  // already listening, with no second switch to find.
  it('starts listening by itself when a patch diagram appears', async () => {
    const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
    switchOn();
    await flushPromises();
    expect(recognisers).toHaveLength(0);

    showPatch();
    await flushPromises();
    expect(wrapper.find('[data-test="voice"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Ready');
  });

  it('lets go of the microphone when the patch goes away', async () => {
    const wrapper = await open({ mode: 'wake' }, { hold: false });
    expect(recognisers).toHaveLength(1);

    clearVoicePatch(voiceTarget.claim);
    await flushPromises();
    expect(wrapper.find('[data-test="voice"]').exists()).toBe(false);
  });

  it('follows the patch it is shown, so a cable goes into the one on screen', async () => {
    api.post.mockResolvedValue({ id: 44 });
    const wrapper = await open();
    showPatch('19');
    await flushPromises();
    await wrapper.find('[data-test="voice-talk"]').trigger('pointerdown');
    await flushPromises();

    spoken('connect maths e o r to 2hp div clock in');
    await flushPromises();
    expect(api.post.mock.calls[0][0]).toBe('/api/patches/19/cables');
  });

  it('plugs the cable it heard', async () => {
    api.post.mockResolvedValue({ id: 44 });
    const wrapper = await open();
    spoken('connect maths e o r to 2hp div clock in');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 1,
      from_component_id: 11,
      to_patch_module_id: 2,
      to_component_id: 21,
      stacked: undefined,
      optional: undefined,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('2hp Div — Clock');
  });

  it('shows the server’s refusal rather than pretending it worked', async () => {
    api.post.mockRejectedValue(new Error("'Clock' already has a cable in it"));
    const wrapper = await open();
    spoken('connect maths e o r to 2hp div clock');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('already has a cable');
    expect(changed).not.toHaveBeenCalled();
  });

  it('asks which jack instead of picking one, and plugs the one you pick', async () => {
    api.post.mockResolvedValue({ id: 45 });
    const wrapper = await open();
    spoken('connect maths to 2hp div clock');
    await flushPromises();

    const options = wrapper.find('[data-test="voice-options"]');
    expect(options.exists()).toBe(true);
    expect(api.post).not.toHaveBeenCalled();

    await wrapper.find('[data-test="voice-option-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('takes the answer to that question out loud too', async () => {
    api.post.mockResolvedValue({ id: 46 });
    const wrapper = await open();
    spoken('connect maths to 2hp div clock');
    await flushPromises();

    // Whichever jack the bar listed second is the one "the second one" means.
    const second = wrapper.find('[data-test="voice-option-2"]').text();
    spoken('the second one');
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    const chosen = fromCandidates.find((c) => c.component_id === api.post.mock.calls[0][1].from_component_id);
    expect(second).toContain(chosen.jack_name);
  });

  it('treats the cable said again as a new cable, not as an answer to the question', async () => {
    api.post.mockResolvedValue({ id: 47 });
    const wrapper = await open();
    spoken('connect maths to 2hp div clock');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-options"]').exists()).toBe(true);

    // Giving up on the numbered list and naming the whole cable properly. The
    // "one" in "channel one" must not be read as picking the first option.
    spoken('connect maths e o r to 2hp div reset');
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0][1]).toMatchObject({ from_component_id: 11, to_component_id: 22 });
    expect(wrapper.find('[data-test="voice-options"]').exists()).toBe(false);
  });

  it('opens one microphone, not two, when voice was already switched on', async () => {
    localStorage.setItem(
      'eurorack-assistant.voice',
      JSON.stringify({ enabled: true, mode: 'wake', engine: 'webspeech' })
    );
    loadVoiceSettings(null, { force: true });
    showPatch();
    mount(VoicePatchPanel, { global: testGlobal() });
    await flushPromises();
    expect(recognisers).toHaveLength(1);
  });

  it('does not close the microphone because the mouse crossed the button', async () => {
    const wrapper = await open({ mode: 'wake' }, { hold: false });
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Listening…');
    await wrapper.find('[data-test="voice-talk"]').trigger('pointerleave');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Listening…');
  });

  it('pulls a cable back out when told to', async () => {
    api.delete.mockResolvedValue({ ok: true });
    await open();
    spoken('unplug maths e o r');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/9');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('undoes the cable it just plugged, and nothing else', async () => {
    api.post.mockResolvedValue({ id: 44 });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = await open();

    spoken('undo that');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('Nothing to undo');

    spoken('connect maths e o r to 2hp div clock');
    await flushPromises();
    spoken('undo that');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/44');
  });

  it('says what it did not understand', async () => {
    const wrapper = await open();
    spoken('what is the airspeed velocity of an unladen swallow');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="voice-message"]').classes()).toContain('error');
  });

  it('says whether patch mode is open or closed', async () => {
    showPatch();
    switchOn({ mode: 'toggle' });
    const wrapper = mount(VoicePatchPanel, { global: testGlobal() });
    await flushPromises();

    const button = wrapper.find('[data-test="voice-talk"]');
    expect(button.text()).toContain('Start patch mode');
    await button.trigger('pointerdown');
    await flushPromises();
    expect(button.text()).toContain('Stop patch mode');
  });

  // A self-hosted box usually runs a Chromium with no key for Google's speech
  // servers, so the browser's recogniser fails the same way every time. The
  // way out is already installed.
  it('offers local Whisper when the browser’s recogniser cannot reach its service', async () => {
    const wrapper = await open();
    expect(wrapper.find('[data-test="voice-use-whisper"]').exists()).toBe(false);

    const errored = vi.spyOn(toast, 'error').mockImplementation(() => {});
    recognisers.at(-1).onerror({ error: 'network' });
    await flushPromises();
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain(
      'could not reach its speech service'
    );
    // An engine that cannot reach its service fails that way every time, so
    // it is worth saying over the page too.
    expect(errored.mock.calls[0][0]).toContain('could not reach its speech service');

    await wrapper.find('[data-test="voice-use-whisper"]').trigger('click');
    await flushPromises();
    expect(voiceSettings.engine).toBe('whisper');
    expect(wrapper.find('[data-test="voice-use-whisper"]').exists()).toBe(false);
  });

  it('lets go of the microphone when the page does', async () => {
    const wrapper = await open();
    expect(recognisers.length).toBeGreaterThan(0);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});
