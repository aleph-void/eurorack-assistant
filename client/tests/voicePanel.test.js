import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
import { toast } from '../src/toast.js';
import { useAuthStore } from '../src/stores/auth.js';
import VoicePatchPanel from '../src/components/VoicePatchPanel.vue';

// The panel builds its own recogniser out of whatever the browser offers, so
// the browser is what the test replaces. `spoken` is the microphone.
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

async function open(props = {}) {
  const wrapper = mount(VoicePatchPanel, {
    props: {
      patchId: '7',
      fromCandidates,
      toCandidates,
      cableCandidates,
      vocabulary: ['Maths', 'Div'],
      ...props,
    },
    global: testGlobal(),
  });
  await wrapper.find('[data-test="voice-enabled"]').setValue(true);
  await flushPromises();
  // Push to talk: hold the button down and leave it down for the test.
  await wrapper.find('[data-test="voice-talk"]').trigger('pointerdown');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  recognisers = [];
  localStorage.clear();
  window.SpeechRecognition = FakeRecognition;
  // jsdom has neither, and the panel must not need them.
  window.AudioContext = undefined;
  window.speechSynthesis = undefined;
});

describe('VoicePatchPanel', () => {
  it('starts switched off and does not open a microphone uninvited', () => {
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    expect(recognisers).toHaveLength(0);
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Off');
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
    expect(wrapper.emitted('changed')).toHaveLength(1);
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('2hp Div — Clock');
  });

  it('shows the server’s refusal rather than pretending it worked', async () => {
    api.post.mockRejectedValue(new Error("'Clock' already has a cable in it"));
    const wrapper = await open();
    spoken('connect maths e o r to 2hp div clock');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-message"]').text()).toContain('already has a cable');
    expect(wrapper.emitted('changed')).toBeUndefined();
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

    // Whichever jack the panel listed second is the one "the second one" means.
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
    mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    expect(recognisers).toHaveLength(1);
  });

  it('does not close the microphone because the mouse crossed the button', async () => {
    localStorage.setItem(
      'eurorack-assistant.voice',
      JSON.stringify({ enabled: true, mode: 'wake', engine: 'webspeech' })
    );
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Listening…');
    await wrapper.find('[data-test="voice-talk"]').trigger('pointerleave');
    await flushPromises();
    expect(wrapper.find('[data-test="voice-status"]').text()).toBe('Listening…');
  });

  it('pulls a cable back out when told to', async () => {
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = await open();
    spoken('unplug maths e o r');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/9');
    expect(wrapper.emitted('changed')).toHaveLength(1);
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

  it('remembers the settings it was given', async () => {
    const wrapper = await open();
    await wrapper.find('[data-test="voice-mode"]').setValue('toggle');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice')).mode).toBe('toggle');
  });

  it('says whether patch mode is open or closed', async () => {
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await wrapper.find('[data-test="voice-enabled"]').setValue(true);
    await wrapper.find('[data-test="voice-mode"]').setValue('toggle');
    await flushPromises();

    const button = wrapper.find('[data-test="voice-talk"]');
    expect(button.text()).toContain('Start patch mode');
    await button.trigger('pointerdown');
    await flushPromises();
    expect(button.text()).toContain('Stop patch mode');
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
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });

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

    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    // Nothing has been asked for yet, so the saved setting is moved quietly.
    expect(wrapper.find('[data-test="voice-engine"]').element.value).toBe('whisper');
    expect(errored).not.toHaveBeenCalled();

    await wrapper.find('[data-test="voice-engine"]').setValue('webspeech');
    await flushPromises();

    expect(errored.mock.calls[0][0]).toContain('Chrome and Edge do; Firefox does not');
    expect(wrapper.find('[data-test="voice-engine"]').element.value).toBe('whisper');
    delete navigator.mediaDevices;
    wrapper.unmount();
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

    // jsdom has no getUserMedia, so Whisper is not on offer here — the button
    // only appears where it could actually be taken.
    expect(wrapper.find('[data-test="voice-use-whisper"]').exists()).toBe(false);
    navigator.mediaDevices = { getUserMedia: vi.fn() };
    const withMic = await open();
    recognisers.at(-1).onerror({ error: 'network' });
    await flushPromises();
    await withMic.find('[data-test="voice-use-whisper"]').trigger('click');
    await flushPromises();
    expect(withMic.find('[data-test="voice-engine"]').element.value).toBe('whisper');
    expect(withMic.find('[data-test="voice-use-whisper"]').exists()).toBe(false);
    delete navigator.mediaDevices;
  });

  it('lets go of the microphone when the page does', async () => {
    const wrapper = await open();
    expect(recognisers.length).toBeGreaterThan(0);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});

// ---- which microphone, which speaker ----

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

describe('the microphone and the speaker', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Scarlett 2i2' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' },
    { kind: 'audiooutput', deviceId: 'out-1', label: 'Studio monitors' },
  ];

  it('lists what this machine has, and offers the system default first', async () => {
    fakeDevices(devices);
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    await openPanels(wrapper);
    const inputs = wrapper.find('[data-test="voice-input-device"]').findAll('option');
    expect(inputs.map((o) => o.element.value)).toEqual(['', 'mic-1', 'mic-2']);
    expect(inputs[1].text()).toBe('Scarlett 2i2');
    expect(
      wrapper.find('[data-test="voice-output-device"]').findAll('option').map((o) => o.element.value)
    ).toEqual(['', 'out-1']);
  });

  // Chosen here, and used by Whisper — the browser's own recogniser opens the
  // system default itself and has no way to be pointed anywhere else.
  it('hands the chosen microphone to the recogniser', async () => {
    fakeDevices(devices);
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    await openPanels(wrapper);
    await wrapper.find('[data-test="voice-enabled"]').setValue(true);
    await wrapper.find('[data-test="voice-input-device"]').setValue('mic-2');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice')).inputDeviceId).toBe('mic-2');
  });

  it('forgets a device that has been unplugged since it was chosen', async () => {
    localStorage.setItem(
      'eurorack-assistant.voice',
      JSON.stringify({ inputDeviceId: 'mic-gone', outputDeviceId: 'out-gone' })
    );
    fakeDevices(devices);
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    await openPanels(wrapper);
    expect(wrapper.find('[data-test="voice-input-device"]').element.value).toBe('');
    expect(wrapper.find('[data-test="voice-output-device"]').element.value).toBe('');
  });

  it('asks for the microphone once when the browser is withholding the names', async () => {
    const { mediaDevices } = fakeDevices([{ kind: 'audioinput', deviceId: 'mic-1', label: '' }]);
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    await openPanels(wrapper);
    const button = wrapper.find('[data-test="voice-devices-refresh"]');
    expect(button.text()).toBe('Show device names');
    await button.trigger('click');
    await flushPromises();
    expect(mediaDevices.getUserMedia).toHaveBeenCalled();
  });

  it('will not offer an output this browser cannot route to', async () => {
    fakeDevices(devices);
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global: testGlobal(),
    });
    await flushPromises();
    await openPanels(wrapper);
    // jsdom has no AudioContext at all, so it certainly has no setSinkId.
    expect(wrapper.find('[data-test="voice-output-device"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="voice-device-help"]').text()).toContain('cannot choose an output');
  });

  // A studio desktop is logged into by more than one person, and a microphone
  // is a personal choice. None of it goes to the server — a device id means
  // nothing on another machine — so the account's name is on the key instead.
  it('keeps each account’s settings apart in the same browser', async () => {
    fakeDevices(devices);
    const global = testGlobal();
    useAuthStore().user = { id: 12 };
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global,
    });
    await flushPromises();
    await openPanels(wrapper);
    await wrapper.find('[data-test="voice-input-device"]').setValue('mic-1');
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('eurorack-assistant.voice.12')).inputDeviceId).toBe('mic-1');
    expect(localStorage.getItem('eurorack-assistant.voice')).toBeNull();
  });

  it('starts a new account off from what this browser was already set to', async () => {
    localStorage.setItem('eurorack-assistant.voice', JSON.stringify({ mode: 'toggle' }));
    fakeDevices(devices);
    const global = testGlobal();
    useAuthStore().user = { id: 12 };
    const wrapper = mount(VoicePatchPanel, {
      props: { patchId: '7', fromCandidates, toCandidates },
      global,
    });
    await flushPromises();
    expect(wrapper.find('[data-test="voice-mode"]').element.value).toBe('toggle');
  });
});
