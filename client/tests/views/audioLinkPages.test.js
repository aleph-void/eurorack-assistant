import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/audio' }),
  };
});

import { api } from '../../src/api.js';
import ModuleAudioView from '../../src/views/ModuleAudioView.vue';
import ModuleLinksView from '../../src/views/ModuleLinksView.vue';
import PatchAudioView from '../../src/views/PatchAudioView.vue';
import PatchWebLinksView from '../../src/views/PatchWebLinksView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';
import { richPatch } from '../patchFixtures.js';

// Each of these pages draws its record's header and one panel, and the panel
// asks for its own list: the record payload is not where recordings or links
// live, so the page makes two calls and neither waits on the other.
function mockApi({ record, list = [], devices = [] }) {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/audio') || path.startsWith('/api/links')) return Promise.resolve(list);
    if (path.startsWith('/api/scope')) return Promise.resolve({ devices });
    if (path.startsWith('/api/modules/') || path.startsWith('/api/patches/')) {
      return Promise.resolve(record);
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('the recordings and links pages', () => {
  it("draws a module's recordings under its header", async () => {
    mockApi({
      record: mathsModule,
      list: [
        {
          id: 5,
          source: 'upload',
          title: 'Sub out',
          duration_seconds: 4,
          peak_dbfs: -6,
          url: '/api/audio/5/file',
          waveform_url: null,
          recorded_at: '2026-02-03T10:00:00.000Z',
        },
      ],
    });
    const wrapper = mount(ModuleAudioView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/audio?module_id=1');
    expect(wrapper.find('[data-test="audio-recordings"]').text()).toContain('Sub out');
  });

  it("draws a module's links under its header", async () => {
    mockApi({
      record: mathsModule,
      list: [{ id: 2, url: 'https://example.org/thread', title: 'Firmware', description: null }],
    });
    const wrapper = mount(ModuleLinksView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/links?module_id=1');
    expect(wrapper.find('[data-test="resource-links"]').text()).toContain('Firmware');
  });

  it("draws a patch's recordings under its header", async () => {
    mockApi({ record: richPatch, list: [] });
    const wrapper = mount(PatchAudioView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/audio?patch_id=7');
    expect(wrapper.find('[data-test="no-audio"]').text()).toContain('No recordings of this patch');
  });

  it("draws a patch's links under its header", async () => {
    mockApi({ record: richPatch, list: [] });
    const wrapper = mount(PatchWebLinksView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/links?patch_id=7');
    expect(wrapper.find('[data-test="no-links"]').text()).toContain('No links on this patch');
  });
});
