import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => ({ query: {}, path: '/modules/1/scope' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleScopeView from '../../src/views/ModuleScopeView.vue';
import { useDevicesStore } from '../../src/stores/devices.js';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { scopeModule } from '../moduleFixtures.js';

const CONNECTION = {
  id: 'conn-1',
  name: 'CVOsc on STUDIO-PC',
  audio_device: { id: 'wasapi:es9', name: 'ES-9', channel_count: 2 },
  channels: [
    { index: 0, name: 'CH 1' },
    { index: 1, name: 'CH 2' },
  ],
};

// The module payload, plus whatever the scope page asks for on top of it.
function mockApi({ remembered = [] } = {}) {
  api.get.mockImplementation(async (path) => {
    if (path === '/api/modules/1') return structuredClone(scopeModule);
    if (path === '/api/scope/modules/1') return { module_id: 1, devices: [], channels: remembered };
    return [];
  });
}

async function mountScope({ connected = true, remembered = [] } = {}) {
  mockApi({ remembered });
  const global_ = testGlobal();
  const devices = useDevicesStore();
  if (connected) devices.connections = [CONNECTION];
  const wrapper = mount(ModuleScopeView, { props: { id: '1' }, global: global_ });
  await flushPromises();
  await openPanels(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  refreshRackModules();
  vi.clearAllMocks();
});

describe('ModuleScopeView', () => {
  it('offers a pane per announced channel, and only the module’s patchable jacks', async () => {
    const wrapper = await mountScope();

    expect(wrapper.find('[data-test="module-scope-connected"]').text()).toContain('ES-9');
    expect(wrapper.find('[data-test="module-pane-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="module-pane-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="module-pane-2"]').exists()).toBe(false);

    // Jacks only — no knob — and no expansion header, which is not a patch
    // point however much it looks like a jack.
    const options = wrapper
      .find('[data-test="module-pane-jack-0"]')
      .findAll('option')
      .map((o) => o.text());
    expect(options).toEqual(['Not named', 'EOR', 'Signal In']);
  });

  it('captures the ticked panes with the jacks they are on', async () => {
    const wrapper = await mountScope();
    api.post.mockResolvedValue({ id: 31 });

    // Pane 1 is on the EOR; pane 2 is untouched and left ticked but unnamed.
    await wrapper.find('[data-test="module-pane-jack-0"]').setValue('21');
    await wrapper.find('[data-test="module-pane-cv-0"]').setValue(true);
    await wrapper.find('[data-test="module-capture-title"]').setValue('Rise sweep');
    await wrapper.find('[data-test="module-scope-capture"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/scope/modules/1/captures', {
      connection_id: 'conn-1',
      title: 'Rise sweep',
      channels: [
        { index: 0, component_id: 21, signal_type: 'cv' },
        { index: 1, component_id: undefined, signal_type: 'audio' },
      ],
    });
    expect(wrapper.find('[data-test="module-scope-status"]').text()).toContain('filed under a note');
  });

  it('records a clip of the ticked panes for the chosen number of seconds', async () => {
    const wrapper = await mountScope();
    api.post.mockResolvedValue({ id: 13 });

    // Untick pane 2: a scope with more inputs than the bench is using should
    // not fill the recording with a flat line.
    await wrapper.find('[data-test="module-pane-check-1"]').setValue(false);
    await wrapper.find('[data-test="module-clip-duration"]').setValue('6');
    await wrapper.find('[data-test="module-clip-title"]').setValue('EOR rising');
    await wrapper.find('[data-test="module-scope-record"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/scope/modules/1/clips', {
      connection_id: 'conn-1',
      title: 'EOR rising',
      duration_seconds: 6,
      channels: [{ index: 0, component_id: undefined, signal_type: 'audio' }],
    });
  });

  it('starts from how the panes were named last time', async () => {
    const wrapper = await mountScope({
      remembered: [
        {
          channel_index: 1,
          component_id: 21,
          component_name: 'EOR',
          label: 'Make Noise Maths — EOR',
          signal_type: 'cv',
        },
      ],
    });
    expect(wrapper.find('[data-test="module-pane-jack-1"]').element.value).toBe('21');
    expect(wrapper.find('[data-test="module-pane-cv-1"]').element.checked).toBe(true);
    expect(wrapper.find('[data-test="module-pane-1"]').text()).toContain('EOR');
  });

  it('lists the captures of this module with their readings, and deletes one', async () => {
    const wrapper = await mountScope();

    const capture = wrapper.find('[data-test="module-capture-30"]');
    expect(capture.text()).toContain('EOR at rest');
    expect(capture.text()).toContain('1.750 V');
    expect(wrapper.find('[data-test="module-capture-image-30"]').attributes('src')).toBe(
      '/api/captures/30/image'
    );

    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.delete.mockResolvedValue({ ok: true });
    await wrapper.find('[data-test="module-capture-delete-30"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/captures/30');
    // The page re-reads the module rather than filtering the row out itself.
    expect(api.get).toHaveBeenCalledWith('/api/modules/1');
  });

  it('says so when no scope is on the line', async () => {
    const wrapper = await mountScope({ connected: false });
    expect(wrapper.find('[data-test="module-scope-disconnected"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="module-scope-capture"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="module-scope-record"]').attributes('disabled')).toBeDefined();
  });

  it('refuses a take with every pane unticked rather than asking for all of them', async () => {
    const wrapper = await mountScope();
    await wrapper.find('[data-test="module-scope-panes-all"]').trigger('click');
    await wrapper.find('[data-test="module-scope-capture"]').trigger('click');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="module-scope-error"]').text()).toContain(
      'Pick at least one channel'
    );
  });

  it('shows the clips recorded of this module too', async () => {
    const wrapper = await mountScope();
    expect(wrapper.find('[data-test="clip-12"]').text()).toContain('EOR rising');
  });
});
