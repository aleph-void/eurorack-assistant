import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const route = { query: {} };
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ push: vi.fn() }), useRoute: () => route };
});

import { api } from '../src/api.js';
import LinkDeviceView from '../src/views/LinkDeviceView.vue';
import DevicesView from '../src/views/DevicesView.vue';
import ScopePanel from '../src/components/ScopePanel.vue';
import PatchNotesPanel from '../src/components/PatchNotesPanel.vue';
import { useDevicesStore } from '../src/stores/devices.js';

const CONNECTION = {
  id: 3,
  token_id: 1,
  name: 'Bench scope',
  audio_device: { id: 'wasapi:es9', name: 'ES-9', channel_count: 2, sample_rate: 48000 },
  channels: [
    { index: 0, name: 'CH 1', signal_type: 'audio' },
    { index: 1, name: 'CH 2', signal_type: 'cv' },
  ],
};

const CHANNELS = [
  {
    id: 1,
    channel_index: 0,
    component_name: 'Input 1',
    label: 'Input 1 (unpatched)',
    signal_type: 'audio',
    source: 'auto',
  },
  {
    id: 2,
    channel_index: 1,
    component_name: 'Input 2',
    label: 'Make Noise Maths — EOR',
    signal_type: 'cv',
    source: 'auto',
  },
];

const PATCH_MODULES = [
  {
    id: 11,
    manufacturer: 'Expert Sleepers',
    module_name: 'ES-9',
    components: [
      { id: 1, type: 'input_jack', name: 'Input 1' },
      { id: 2, type: 'input_jack', name: 'Input 2' },
      { id: 3, type: 'knob', name: 'Gain' },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  route.query = {};
});

describe('LinkDeviceView', () => {
  it('looks up a code from the query string and approves it', async () => {
    route.query = { code: 'WDJB-MJHT' };
    api.get.mockResolvedValue({
      user_code: 'WDJB-MJHT',
      client_id: 'cvosc',
      client_name: 'CVOsc oscilloscope',
      device_name: 'CVOsc on STUDIO-PC',
      scopes: 'oscilloscope',
    });
    api.post.mockResolvedValue({ ok: true });

    const wrapper = mount(LinkDeviceView, { global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/devices/authorizations/WDJB-MJHT');
    expect(wrapper.find('[data-test="pending"]').text()).toContain('CVOsc oscilloscope');

    await wrapper.find('[data-test="device-name"]').setValue('Bench scope');
    await wrapper.find('[data-test="approve"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/devices/authorizations/WDJB-MJHT/approve', {
      name: 'Bench scope',
    });
    expect(wrapper.find('[data-test="done"]').text()).toContain('Approved');
  });

  it('shows why an unknown code did not work', async () => {
    api.get.mockRejectedValue(new Error('That code is not valid or has expired'));
    const wrapper = mount(LinkDeviceView, { global: testGlobal() });
    await wrapper.find('[data-test="code-input"]').setValue('AAAA-BBBB');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('not valid');
    expect(wrapper.find('[data-test="pending"]').exists()).toBe(false);
  });
});

describe('DevicesView', () => {
  it('lists linked devices with what they are reading, and revokes one', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        name: 'Bench scope',
        client_id: 'cvosc',
        created_at: '2026-08-12T10:00:00Z',
        connections: [CONNECTION],
      },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const wrapper = mount(DevicesView, { global: testGlobal() });
    await flushPromises();
    const panel = wrapper.find('[data-test="device-1"]');
    expect(panel.text()).toContain('Bench scope');
    expect(panel.text()).toContain('ES-9');
    expect(panel.find('[data-test="connected"]').exists()).toBe(true);

    await wrapper.find('[data-test="revoke-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/devices/1');
    expect(wrapper.find('[data-test="device-1"]').exists()).toBe(false);
  });
});

describe('ScopePanel', () => {
  const mountPanel = () => {
    const wrapper = mount(ScopePanel, {
      props: { patchId: '7', modules: PATCH_MODULES },
      global: testGlobal(),
    });
    return wrapper;
  };

  it('says nothing is connected when no scope is on the line', async () => {
    api.get.mockResolvedValue([]);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-test="scope-disconnected"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="scope-automap"]').attributes('disabled')).toBeDefined();
  });

  it('maps channels automatically and shows what each pane is watching', async () => {
    api.get.mockImplementation(async (path) =>
      path.startsWith('/api/scope') ? { patch_id: 7, channels: [], devices: [] } : []
    );
    api.post.mockResolvedValue({
      matched_by: 'device_name',
      interface: { manufacturer: 'Expert Sleepers', module_name: 'ES-9' },
      labels_pushed: true,
      channels: CHANNELS,
    });

    const wrapper = mountPanel();
    useDevicesStore().connections = [CONNECTION];
    await flushPromises();

    await wrapper.find('[data-test="scope-automap"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/scope/patches/7/automap', { connection_id: 3 });
    expect(wrapper.find('[data-test="scope-channel-1"]').text()).toContain(
      'Make Noise Maths — EOR'
    );
    expect(wrapper.find('[data-test="scope-status"]').text()).toContain('pushed the names');
  });

  it('maps one channel by hand, offering only jacks', async () => {
    api.get.mockImplementation(async (path) =>
      path.startsWith('/api/scope') ? { patch_id: 7, channels: CHANNELS, devices: [] } : []
    );
    api.put.mockResolvedValue({ ...CHANNELS[0], component_name: 'Input 2', source: 'manual' });

    const wrapper = mountPanel();
    useDevicesStore().connections = [CONNECTION];
    await flushPromises();

    await wrapper.find('[data-test="scope-override-module-0"]').setValue(11);
    const jacks = wrapper.find('[data-test="scope-override-jack-0"]').findAll('option');
    // The knob is not something a scope can watch.
    expect(jacks.map((o) => o.text())).toEqual(['Jack…', 'Input 1', 'Input 2']);

    await wrapper.find('[data-test="scope-override-jack-0"]').setValue(2);
    await wrapper.find('[data-test="scope-override-save-0"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/scope/patches/7/channels/0', {
      patch_module_id: 11,
      component_id: 2,
    });
    expect(wrapper.find('[data-test="scope-channel-0"]').text()).toContain('manual');
  });

  it('captures a waveform and renders it with its readings', async () => {
    api.get.mockImplementation(async (path) =>
      path.startsWith('/api/scope') ? { patch_id: 7, channels: CHANNELS, devices: [] } : []
    );
    api.post.mockResolvedValue({
      id: 5,
      title: 'Krell gate',
      image_hash: 'abc',
      captured_at: '2026-08-12T18:00:00Z',
      device_name: 'Bench scope',
      channels: [
        {
          id: 1,
          channel_index: 1,
          label: 'Make Noise Maths — EOR',
          signal_type: 'cv',
          source_description: 'patched from Make Noise Maths EOR',
          voltage: 1.75,
          note_name: 'A2',
          cents: 0,
        },
      ],
    });

    const wrapper = mountPanel();
    useDevicesStore().connections = [CONNECTION];
    await flushPromises();

    await wrapper.find('[data-test="capture-title"]').setValue('Krell gate');
    await wrapper.find('[data-test="scope-capture"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/scope/patches/7/captures', {
      connection_id: 3,
      title: 'Krell gate',
    });
    const capture = wrapper.find('[data-test="capture-5"]');
    expect(capture.find('[data-test="capture-image-5"]').attributes('src')).toBe(
      '/api/captures/5/image'
    );
    expect(capture.text()).toContain('A2 +0¢');
    expect(capture.text()).toContain('1.750 V');
    expect(wrapper.emitted('captured')).toBeTruthy();
  });

  it('surfaces a device that did not answer', async () => {
    api.get.mockImplementation(async (path) =>
      path.startsWith('/api/scope') ? { patch_id: 7, channels: CHANNELS, devices: [] } : []
    );
    api.post.mockRejectedValue(new Error('device did not answer capture within 30000ms'));

    const wrapper = mountPanel();
    useDevicesStore().connections = [CONNECTION];
    await flushPromises();
    await wrapper.find('[data-test="scope-capture"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="scope-error"]').text()).toContain('did not answer');
  });
});

describe('PatchNotesPanel', () => {
  it('lists patch notes with their captures and adds a new one', async () => {
    api.get.mockResolvedValue([
      {
        id: 4,
        title: 'Waveform — Krell',
        body: '| Channel | Signal | Reading |',
        captures: [{ id: 5, image_hash: 'abc', title: 'Krell gate' }],
        modules: [],
      },
    ]);
    api.post.mockResolvedValue({ id: 6 });

    const wrapper = mount(PatchNotesPanel, { props: { patchId: '7' }, global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/notes?patch_id=7');
    expect(wrapper.find('[data-test="patch-note-4"]').text()).toContain('Waveform — Krell');
    expect(wrapper.find('[data-test="patch-note-capture-5"]').attributes('src')).toBe(
      '/api/captures/5/image'
    );

    await wrapper.find('[data-test="patch-note-body"]').setValue('Try a longer rise');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes', {
      title: undefined,
      body: 'Try a longer rise',
      patch_ids: [7],
    });
  });

  it('detaches a note without deleting it', async () => {
    api.get.mockResolvedValue([{ id: 4, title: 'Bench log', body: 'x', captures: [], modules: [] }]);
    api.post.mockResolvedValue({ ok: true });
    const wrapper = mount(PatchNotesPanel, { props: { patchId: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="patch-note-detach-4"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes/4/detach', { patch_id: 7 });
    expect(wrapper.find('[data-test="patch-note-4"]').exists()).toBe(false);
  });
});

describe('devices store', () => {
  it('tracks connect, state and disconnect events', () => {
    testGlobal();
    const devices = useDevicesStore();
    devices.applyEvent({ kind: 'device', event: 'connected', device: { id: 1, name: 'a' } });
    expect(devices.connectionCount).toBe(1);

    devices.applyEvent({
      kind: 'device',
      event: 'state',
      device: { id: 1, name: 'a', channels: [{ index: 0 }] },
    });
    expect(devices.connectionCount).toBe(1);
    expect(devices.current.channels).toHaveLength(1);

    devices.applyEvent({ kind: 'job', event: 'progress', job: { id: 9 } });
    expect(devices.connectionCount).toBe(1);

    devices.applyEvent({ kind: 'device', event: 'disconnected', device: { id: 1 } });
    expect(devices.connectionCount).toBe(0);
    expect(devices.current).toBeNull();
  });
});
