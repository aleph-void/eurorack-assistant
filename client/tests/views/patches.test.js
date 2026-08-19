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

  const systemsResponse = [{ id: 7, name: 'studio', rack_count: 2, module_count: 9 }];

  function mockLists(patches, { systems = [] } = {}) {
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      if (path === '/api/systems') return Promise.resolve(systems);
      return Promise.resolve(patches);
    });
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
    // With no systems, the first rack that actually has modules is preselected.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('rack:1');
    await wrapper.find('[data-test="new-name"]').setValue('Krell');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      rack_id: 1,
      name: 'Krell',
      description: undefined,
    });
  });

  it('creates a patch from a whole system, which is preselected over a rack', async () => {
    mockLists([], { systems: systemsResponse });
    api.post.mockResolvedValue({ id: 10 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    // A system spans every rack in it, so it is the more useful default.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('system:7');
    await wrapper.find('[data-test="new-name"]').setValue('Whole studio');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      system_id: 7,
      name: 'Whole studio',
      description: undefined,
    });
  });

  it('names a system patch by its system, with a badge', async () => {
    mockLists(
      [
        {
          id: 5,
          name: 'Whole studio',
          rack_name: 'studio',
          system_id: 7,
          system_name: 'studio',
          module_count: 9,
          cable_count: 4,
          created_at: '2026-08-12T10:00:00Z',
        },
      ],
      { systems: systemsResponse }
    );
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="patch-5"]');
    expect(row.text()).toContain('studio');
    expect(row.find('[data-test="system-badge"]').exists()).toBe(true);
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
