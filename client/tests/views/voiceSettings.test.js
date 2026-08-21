import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

import { toast } from '../../src/toast.js';
import VoiceSettingsView from '../../src/views/VoiceSettingsView.vue';
import {
  loadVoiceSettings,
  resetVoiceSettings,
  voiceSettings,
} from '../../src/voiceSettings.js';
import { clearVoicePatch, setVoicePatch, voiceTarget } from '../../src/voicePatchTarget.js';

class FakeRecognition {
  start() {}
  stop() {}
  abort() {}
}

const fakeDevices = (devices) => {
  const listeners = new Map();
  const mediaDevices = {
    enumerateDevices: async () => devices,
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
  return { mediaDevices, fire: (type) => listeners.get(type)?.() };
};

const devices = [
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Scarlett 2i2' },
  { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' },
  { kind: 'audiooutput', deviceId: 'out-1', label: 'Studio monitors' },
];

const open = async () => {
  const wrapper = mount(VoiceSettingsView, { global: testGlobal() });
  await flushPromises();
  await openPanels(wrapper);
  return wrapper;
};

// Every setting and the patch on screen are now ONE object for the whole app
// rather than one per component, so a panel left mounted by a finished test
// reacts to the next test's setup — a second microphone opened, a settings
// page correcting an engine the other one just chose. Each test takes its
// components away with it.
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearVoicePatch(voiceTarget.claim);
  resetVoiceSettings();
  loadVoiceSettings(null);
  window.SpeechRecognition = FakeRecognition;
  window.AudioContext = undefined;
  window.speechSynthesis = undefined;
  delete navigator.mediaDevices;
});

// Voice patching is a way of working, not a property of a patch: it is set up
// once, here, and the listener runs over whichever patch diagram is open.
describe('VoiceSettingsView', () => {
  it('switches voice patching on for the whole account, not for one patch', async () => {
    const wrapper = await open();
    await wrapper.find('[data-test="voice-enabled"]').setValue(true);
    await flushPromises();
    expect(voiceSettings.enabled).toBe(true);
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice')).enabled).toBe(true);
  });

  it('says whether there is a patch on screen for it to listen over', async () => {
    const wrapper = await open();
    await wrapper.find('[data-test="voice-enabled"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-test="voice-where"]').text()).toContain('open a patch');

    setVoicePatch('7', { label: 'Krell' });
    await flushPromises();
    expect(wrapper.find('[data-test="voice-where"]').text()).toContain("Listening over 'Krell'");
  });

  it('remembers the settings it was given', async () => {
    const wrapper = await open();
    await wrapper.find('[data-test="voice-mode"]').setValue('toggle');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice')).mode).toBe('toggle');
  });

  it('offers Whisper as the other way of listening', async () => {
    const wrapper = await open();
    const engines = wrapper.find('[data-test="voice-engine"]').findAll('option');
    expect(engines.map((o) => o.element.value)).toEqual(['webspeech', 'whisper']);
    // Both are always pickable. jsdom hands over no microphone, so Whisper
    // says so in its own line rather than being greyed out without a reason.
    expect(engines.map((o) => o.attributes('disabled'))).toEqual([undefined, undefined]);
    expect(engines[1].text()).toContain('not available here');
  });

  // A greyed-out line says "no" without ever saying why, and the why is
  // different for each engine. So either can be picked, and picking one this
  // browser cannot run explains itself — over the page as well as beside the
  // picker, because settings are a fold that is easy to look away from.
  it('says why an engine this browser cannot run cannot be chosen, and stays on one that works', async () => {
    const errored = vi.spyOn(toast, 'error').mockImplementation(() => {});
    const wrapper = await open();

    await wrapper.find('[data-test="voice-engine"]').setValue('whisper');
    await flushPromises();

    expect(errored).toHaveBeenCalledTimes(1);
    expect(errored.mock.calls[0][0]).toContain('will not hand over a microphone');
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('HTTPS or localhost');
    // The choice does not stick: the picker goes back to the engine that runs.
    expect(wrapper.find('[data-test="voice-engine"]').element.value).toBe('webspeech');
    wrapper.unmount();
  });

  it('says the other half of it in a browser with no recogniser of its own', async () => {
    const errored = vi.spyOn(toast, 'error').mockImplementation(() => {});
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    navigator.mediaDevices = { getUserMedia: vi.fn() };
    // Nothing has been asked for yet, so the saved setting is moved quietly.
    loadVoiceSettings(null, { force: true });

    const wrapper = await open();
    expect(wrapper.find('[data-test="voice-engine"]').element.value).toBe('whisper');
    expect(errored).not.toHaveBeenCalled();

    await wrapper.find('[data-test="voice-engine"]').setValue('webspeech');
    await flushPromises();

    expect(errored.mock.calls[0][0]).toContain('Chrome and Edge do; Firefox does not');
    expect(wrapper.find('[data-test="voice-engine"]').element.value).toBe('whisper');
    wrapper.unmount();
  });
});

// ---- which microphone, which speaker ----

describe('the microphone and the speaker', () => {
  it('lists what this machine has, and offers the system default first', async () => {
    fakeDevices(devices);
    const wrapper = await open();
    const inputs = wrapper.find('[data-test="voice-input-device"]').findAll('option');
    expect(inputs.map((o) => o.element.value)).toEqual(['', 'mic-1', 'mic-2']);
    expect(inputs[1].text()).toBe('Scarlett 2i2');
    expect(
      wrapper.find('[data-test="voice-output-device"]').findAll('option').map((o) => o.element.value)
    ).toEqual(['', 'out-1']);
  });

  // Chosen here, and used by Whisper — the browser's own recogniser opens the
  // system default itself and has no way to be pointed anywhere else.
  it('keeps the chosen microphone for the listener to pick up', async () => {
    fakeDevices(devices);
    const wrapper = await open();
    await wrapper.find('[data-test="voice-input-device"]').setValue('mic-2');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice')).inputDeviceId).toBe('mic-2');
  });

  it('forgets a device that has been unplugged since it was chosen', async () => {
    localStorage.setItem(
      'eurorack-assistant.voice',
      JSON.stringify({ inputDeviceId: 'mic-gone', outputDeviceId: 'out-gone' })
    );
    loadVoiceSettings(null, { force: true });
    fakeDevices(devices);
    const wrapper = await open();
    expect(wrapper.find('[data-test="voice-input-device"]').element.value).toBe('');
    expect(wrapper.find('[data-test="voice-output-device"]').element.value).toBe('');
  });

  it('asks for the microphone once when the browser is withholding the names', async () => {
    const { mediaDevices } = fakeDevices([{ kind: 'audioinput', deviceId: 'mic-1', label: '' }]);
    const wrapper = await open();
    const button = wrapper.find('[data-test="voice-devices-refresh"]');
    expect(button.text()).toBe('Show device names');
    await button.trigger('click');
    await flushPromises();
    expect(mediaDevices.getUserMedia).toHaveBeenCalled();
  });

  it('will not offer an output this browser cannot route to', async () => {
    fakeDevices(devices);
    const wrapper = await open();
    // jsdom has no AudioContext at all, so it certainly has no setSinkId.
    expect(wrapper.find('[data-test="voice-output-device"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="voice-device-help"]').text()).toContain('cannot choose an output');
  });

  // A studio desktop is logged into by more than one person, and a microphone
  // is a personal choice. None of it goes to the server — a device id means
  // nothing on another machine — so the account's name is on the key instead.
  it('keeps each account’s settings apart in the same browser', async () => {
    fakeDevices(devices);
    loadVoiceSettings(12, { force: true });
    const wrapper = await open();
    await wrapper.find('[data-test="voice-input-device"]').setValue('mic-1');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice.12')).inputDeviceId).toBe('mic-1');
    expect(localStorage.getItem('eurorack-assistant.voice')).toBeNull();
  });

  it('starts a new account off from what this browser was already set to', async () => {
    localStorage.setItem('eurorack-assistant.voice', JSON.stringify({ mode: 'toggle' }));
    fakeDevices(devices);
    loadVoiceSettings(12, { force: true });
    const wrapper = await open();
    expect(wrapper.find('[data-test="voice-mode"]').element.value).toBe('toggle');
  });
});
