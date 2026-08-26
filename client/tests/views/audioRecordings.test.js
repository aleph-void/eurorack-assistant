import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal, waitFor } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import AudioRecordings from '../../src/components/AudioRecordings.vue';

const recording = {
  id: 5,
  module_id: 1,
  patch_id: null,
  patch_name: null,
  source: 'upload',
  title: 'Sub out',
  caption: 'sounds thin',
  original_name: 'sub-out.wav',
  audio_format: 'wav',
  duration_seconds: 12.5,
  sample_rate: 48000,
  channel_count: 2,
  peak_dbfs: -1.5,
  rms_dbfs: -18.2,
  url: '/api/audio/5/file',
  waveform_url: '/api/audio/5/waveform',
  recorded_at: '2026-02-03T10:00:00.000Z',
};

// The panel asks two things on mount: its own list, and whether a scope that
// can record audio is connected.
function mockLoad({ recordings = [recording], devices = [] } = {}) {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/audio')) return Promise.resolve(recordings);
    if (path.startsWith('/api/scope')) return Promise.resolve({ devices });
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AudioRecordings', () => {
  it('lists a module s recordings with what was measured off them', async () => {
    mockLoad();
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/audio?module_id=1');
    const row = wrapper.find('[data-test="audio-5"]');
    expect(row.text()).toContain('Sub out');
    expect(row.text()).toContain('sounds thin');
    expect(row.text()).toContain('12.5s');
    expect(row.text()).toContain('-1.5 dBFS peak');
    expect(row.find('audio').attributes('src')).toBe('/api/audio/5/file');
  });

  // Peak at full scale is the number that decides whether a take is usable.
  it('says so when a recording is clipping', async () => {
    mockLoad({ recordings: [{ ...recording, peak_dbfs: 0 }] });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/audio?patch_id=7');
    expect(wrapper.find('[data-test="audio-5"]').text()).toContain('clipping');
  });

  it('shows the waveform picture only when asked for it', async () => {
    mockLoad();
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="audio-waveform"]').exists()).toBe(false);

    await wrapper.find('[data-test="audio-waveform-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="audio-waveform"]').attributes('src')).toBe(
      '/api/audio/5/waveform'
    );
  });

  it('uploads a picked file as base64 and puts it at the top of the list', async () => {
    mockLoad({ recordings: [] });
    api.post.mockResolvedValue({ ...recording, id: 9, title: null });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'take.wav', { type: 'audio/wav' });
    const input = wrapper.find('[data-test="audio-file"]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    // FileReader finishes on a task, not a microtask.
    await waitFor(() => api.post.mock.calls.length > 0, 'the upload');

    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe('/api/audio');
    expect(body.module_id).toBe(1);
    expect(body.source).toBe('upload');
    expect(body.filename).toBe('take.wav');
    expect(body.data_base64).toBe('AQIDBA==');
    await flushPromises();
    expect(wrapper.find('[data-test="audio-9"]').exists()).toBe(true);
  });

  // The button that asks the oscilloscope is only there while something that
  // can answer is on the line — a button that always fails is not a button.
  it('offers the oscilloscope only when a device that can record is connected', async () => {
    mockLoad({ devices: [{ id: 3, name: 'CVOsc', capabilities: ['capture'] }] });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="record-from-scope"]').exists()).toBe(false);

    mockLoad({ devices: [{ id: 3, name: 'CVOsc', capabilities: ['capture', 'record_audio'] }] });
    const withScope = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();
    const button = withScope.find('[data-test="record-from-scope"]');
    expect(button.text()).toContain('CVOsc');

    api.post.mockResolvedValue({ ...recording, id: 11, source: 'device' });
    await withScope.find('[data-test="scope-seconds"]').setValue('30');
    await button.trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/scope/patches/7/audio', {
      duration_seconds: 30,
      connection_id: 3,
    });
    expect(withScope.find('[data-test="audio-11"]').exists()).toBe(true);
  });

  it('renames a recording and deletes one', async () => {
    mockLoad();
    api.put.mockResolvedValue({ ...recording, title: 'Take 3' });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="audio-edit"]').trigger('click');
    await wrapper.find('[data-test="audio-title-input"]').setValue('Take 3');
    await wrapper.find('[data-test="audio-save"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/audio/5', {
      title: 'Take 3',
      caption: 'sounds thin',
    });
    expect(wrapper.find('[data-test="audio-5"]').text()).toContain('Take 3');

    await wrapper.find('[data-test="audio-delete"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/audio/5');
    expect(wrapper.find('[data-test="no-audio"]').exists()).toBe(true);
  });

  it('backs out of a rename without writing anything', async () => {
    mockLoad();
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="audio-edit"]').trigger('click');
    await wrapper.find('[data-test="audio-title-input"]').setValue('half a thought');
    await wrapper.find('[data-test="audio-caption-input"]').setValue('and half a note');
    await wrapper.findAll('[data-test="audio-5"] button')[1].trigger('click');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="audio-5"]').text()).toContain('Sub out');
  });

  // What a take IS cannot be edited — only what it is called and what the
  // person who made it says about it.
  it('saves a new caption with the title', async () => {
    mockLoad();
    api.put.mockResolvedValue({ ...recording, caption: 'the buzz starts at 0:04' });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="audio-edit"]').trigger('click');
    await wrapper.find('[data-test="audio-caption-input"]').setValue('the buzz starts at 0:04');
    await wrapper.find('[data-test="audio-save"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/audio/5', {
      title: 'Sub out',
      caption: 'the buzz starts at 0:04',
    });
    expect(wrapper.find('[data-test="audio-5"]').text()).toContain('the buzz starts at 0:04');
  });

  it('says what went wrong instead of losing the failure', async () => {
    mockLoad({ recordings: [] });
    api.post.mockRejectedValue(new Error('recordings are limited to 25MB'));
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    const file = new File([new Uint8Array([1])], 'huge.wav', { type: 'audio/wav' });
    const input = wrapper.find('[data-test="audio-file"]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await waitFor(
      () => wrapper.find('[data-test="audio-error"]').exists(),
      'the failure to be said'
    );
    expect(wrapper.find('[data-test="audio-error"]').text()).toContain('25MB');
  });
});

// A stand-in for the browser's own recorder: `stop()` hands over one chunk
// and ends the take, which is the whole of what the panel drives.
class FakeRecorder {
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    this.state = 'inactive';
    FakeRecorder.last = this;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([26, 69, 223, 163])]) });
    this.onstop?.();
  }
}

// Puts a recorder and an input on the window, and answers with the tracks the
// panel is expected to release when the take ends.
function fakeMicrophone({ refused = false } = {}) {
  const track = { stop: vi.fn() };
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: refused
        ? vi.fn().mockRejectedValue(new Error('Permission denied'))
        : vi.fn().mockResolvedValue({ getTracks: () => [track] }),
    },
  });
  return { track };
}

function forgetMicrophone() {
  delete window.MediaRecorder;
  delete FakeRecorder.last;
  Reflect.deleteProperty(window.navigator, 'mediaDevices');
}

describe('recording in the browser', () => {
  afterEach(forgetMicrophone);

  it('records a take, stores it as one, and lets go of the input', async () => {
    const { track } = fakeMicrophone();
    mockLoad({ recordings: [] });
    api.post.mockResolvedValue({ ...recording, id: 12, source: 'browser', title: null });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="record-here"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="recording-now"]').exists()).toBe(true);
    // While a take is running there is nothing to start, only something to stop.
    expect(wrapper.find('[data-test="record-here"]').exists()).toBe(false);

    await wrapper.find('[data-test="stop-recording"]').trigger('click');
    await waitFor(() => api.post.mock.calls.length > 0, 'the take to be stored');

    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe('/api/audio');
    expect(body).toMatchObject({ patch_id: 7, source: 'browser', filename: null });
    expect(body.data_base64.length).toBeGreaterThan(0);
    // A page still holding the input open is a page nothing else can record
    // through.
    expect(track.stop).toHaveBeenCalled();
    await flushPromises();
    expect(wrapper.find('[data-test="recording-now"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="audio-12"]').exists()).toBe(true);
  });

  it('says so when the microphone is refused, and stays ready to try again', async () => {
    fakeMicrophone({ refused: true });
    mockLoad({ recordings: [] });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="record-here"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="record-error"]').text()).toContain('Permission denied');
    expect(wrapper.find('[data-test="recording-now"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="record-here"]').exists()).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  // A take still running when the page goes would hold the input open for
  // good, so leaving the page ends it.
  it('ends a running take when the page is left', async () => {
    const { track } = fakeMicrophone();
    mockLoad({ recordings: [] });
    api.post.mockResolvedValue({ ...recording, id: 13, source: 'browser' });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();
    await wrapper.find('[data-test="record-here"]').trigger('click');
    await flushPromises();

    wrapper.unmount();
    await waitFor(() => track.stop.mock.calls.length > 0, 'the input to be released');
  });

  // Without a recorder on the window there is nothing to offer; the other two
  // ways in are still there.
  it('offers no take at all where the browser cannot record', async () => {
    mockLoad({ recordings: [] });
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="record-here"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="audio-file"]').exists()).toBe(true);
  });
});

describe('when something goes wrong', () => {
  it('says why the list could not be read', async () => {
    api.get.mockImplementation((path) =>
      path.startsWith('/api/audio')
        ? Promise.reject(new Error('Request failed (500)'))
        : Promise.resolve({ devices: [] })
    );
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="audio-list-error"]').text()).toContain('500');
  });

  // Whether a scope is connected is a secondary question: a page whose list
  // loaded is not broken because that one failed.
  it('offers no oscilloscope when it cannot tell whether one is there', async () => {
    api.get.mockImplementation((path) =>
      path.startsWith('/api/audio')
        ? Promise.resolve([])
        : Promise.reject(new Error('Request failed (503)'))
    );
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="record-from-scope"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="no-audio"]').exists()).toBe(true);
  });

  it('says what the oscilloscope refused', async () => {
    mockLoad({
      recordings: [],
      devices: [{ id: 3, name: 'CVOsc', capabilities: ['record_audio'] }],
    });
    api.post.mockRejectedValue(new Error('No oscilloscope is connected'));
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'patch', recordId: '7' },
      global: testGlobal(),
    });
    await flushPromises();

    await wrapper.find('[data-test="record-from-scope"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="audio-error"]').text()).toContain('No oscilloscope');
  });

  it('reads the new record when the page is pointed at another one', async () => {
    mockLoad();
    const wrapper = mount(AudioRecordings, {
      props: { kind: 'module', recordId: '1' },
      global: testGlobal(),
    });
    await flushPromises();
    await wrapper.find('[data-test="audio-waveform-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="audio-waveform"]').exists()).toBe(true);

    await wrapper.setProps({ recordId: '2' });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/audio?module_id=2');
    // The picture that was open belonged to the record being left.
    expect(wrapper.find('[data-test="audio-waveform"]').exists()).toBe(false);
  });
});
