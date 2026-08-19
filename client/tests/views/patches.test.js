import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => ({ query: currentRouteQuery }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import PatchesView from '../../src/views/PatchesView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchesView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3 },
    { id: 2, name: 'empty case', module_count: 0 },
  ];

  function mockLists(patches) {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : patches)
    );
  }

  it('lists patches with their rack and counts', async () => {
    mockLists([
      {
        id: 5,
        name: 'Krell',
        description: 'self-generating',
        rack_name: 'main rack',
        module_count: 3,
        cable_count: 2,
        created_at: '2026-08-12T10:00:00Z',
      },
    ]);
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="patch-5"]');
    expect(row.text()).toContain('Krell');
    expect(row.text()).toContain('self-generating');
    expect(row.text()).toContain('main rack');
  });

  it('duplicates a patch from the list', async () => {
    mockLists([
      {
        id: 5,
        name: 'Krell',
        rack_name: 'main rack',
        module_count: 3,
        cable_count: 2,
        created_at: '2026-08-12T10:00:00Z',
      },
    ]);
    api.post.mockResolvedValue({ id: 6, name: 'Krell (copy)' });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="duplicate-5"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/5/clone', {});
    // The list is reloaded so the copy shows up.
    expect(api.get).toHaveBeenCalledWith('/api/patches');
  });

  it('creates a patch from the selected rack', async () => {
    mockLists([]);
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
    // The first rack that actually has modules is preselected.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('1');
    await wrapper.find('[data-test="new-name"]').setValue('Krell');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      rack_id: 1,
      name: 'Krell',
      description: undefined,
    });
  });

  it('deletes a patch after confirmation', async () => {
    mockLists([
      { id: 5, name: 'Krell', rack_name: 'main rack', module_count: 3, cable_count: 0, created_at: '2026-08-12T10:00:00Z' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/5');
    expect(wrapper.find('[data-test="patch-5"]').exists()).toBe(false);
  });
});
