import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
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
  });

  it('lets go of the microphone when the page does', async () => {
    const wrapper = await open();
    expect(recognisers.length).toBeGreaterThan(0);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});
