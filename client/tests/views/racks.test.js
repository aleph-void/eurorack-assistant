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
import RacksView from '../../src/views/RacksView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('RacksView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3 },
    { id: 2, name: 'travel case', module_count: 1 },
  ];

  it('lists racks with module counts and creates a new one', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ id: 3, name: 'studio', module_count: 0 });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack-1"]').text()).toContain('main rack');
    expect(wrapper.find('[data-test="rack-1"]').text()).toContain('3');
    expect(wrapper.find('[data-test="rack-2"]').text()).toContain('travel case');

    await wrapper.find('[data-test="new-rack"]').setValue('studio');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks', { name: 'studio' });
  });

  it('renders placed modules as panel images inside an organized rack row', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      return Promise.resolve({
        id: 1,
        name: 'main rack',
        modules: [{ id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, quantity: 1 }],
        rows: [{ id: 9, unit: 3, hp: 84, modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, panel: { url: '/api/panels/arp.svg' } }] }],
      });
    });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();
    const row = wrapper.find('[data-test="rack-row-0"]');
    expect(row.find('img').attributes('src')).toBe('/api/panels/arp.svg');
    expect(row.find('.placed-module').attributes('style')).toContain('--module-hp: 2');
  });

  it('persists the module id when a panel is dragged from inventory into a row', async () => {
    const detail = {
      id: 1,
      name: 'main rack',
      modules: [{ id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, quantity: 1, panel: { url: '/api/panels/arp.svg' } }],
      rows: [{ id: 9, unit: 3, hp: 84, modules: [] }],
    };
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/racks' ? racksResponse : detail));
    api.put.mockResolvedValue({ rows: [{ ...detail.rows[0], modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, panel: { url: '/api/panels/arp.svg' } }] }] });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="available-module-4-0"]').trigger('dragstart');
    await wrapper.find('[data-test="rack-row-0"] .rack-row-slots').trigger('drop');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }] }],
    });
    expect(wrapper.find('[data-test="rack-row-0"] img').attributes('src')).toBe('/api/panels/arp.svg');
  });

  it('renames a rack', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.put.mockResolvedValue({ id: 2, name: 'live case', module_count: 1 });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rename-2"]').trigger('click');
    await wrapper.find('[data-test="rename-input-2"]').setValue('live case');
    await wrapper.find('[data-test="rack-2"] form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/2', { name: 'live case' });
  });

  it('queues a rack export and tells the user the download is automatic', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ id: 12, type: 'export_rack', status: 'pending' });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="export-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks/1/export');
    expect(wrapper.find('[data-test="notice"]').text()).toContain('downloads automatically');

    api.post.mockRejectedValue(new Error('Rack not found'));
    await wrapper.find('[data-test="export-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Rack not found');
  });

  it('deletes a rack after confirmation and surfaces errors', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/racks/2');
    expect(wrapper.find('[data-test="rack-2"]').exists()).toBe(false);

    api.delete.mockRejectedValue(new Error('nope'));
    await wrapper.find('[data-test="delete-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('nope');
    vi.restoreAllMocks();
  });
});
