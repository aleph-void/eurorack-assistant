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
import ModulesView from '../../src/views/ModulesView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModulesView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 1 },
    { id: 2, name: 'travel case', module_count: 0 },
  ];

  // ModulesView loads the rack list and the (optionally rack-scoped) modules.
  function mockLists(modules) {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : modules)
    );
  }

  it('renders the module table with status badges and rack placements', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 2,
        racks: [{ id: 1, name: 'main rack', quantity: 2 }],
        manual_status: 'found',
        analysis_status: 'complete',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/modules');
    const row = wrapper.find('[data-test="module-1"]');
    expect(row.text()).toContain('Make Noise');
    expect(row.text()).toContain('Maths');
    expect(row.text()).toContain('main rack');
    expect(row.text()).toContain('found');
    expect(row.text()).toContain('complete');
    expect(row.find('a').attributes('to')).toBe('/modules/1?rack=1');
  });

  it('shows the empty state', async () => {
    mockLists([]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.text()).toContain('No modules yet');
  });

  it('adds and removes components from a module row', async () => {
    const module = {
      id: 1,
      manufacturer: '2hp',
      name: 'ARP',
      quantity: 1,
      racks: [{ id: 1, name: 'main rack', quantity: 1 }],
      manual_status: 'found',
      analysis_status: 'complete',
    };
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      if (path === '/api/modules/1') return Promise.resolve({ components: [{ id: 10, name: 'ROOT', type: 'input_jack' }] });
      return Promise.resolve([module]);
    });
    api.post.mockResolvedValue({ id: 11, name: 'ROOT', type: 'knob' });
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);

    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="components-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="component-editor-1"]').text()).toContain('ROOT');

    await wrapper.find('[data-test="component-name-1"]').setValue('ROOT');
    await wrapper.find('[data-test="component-type-1"]').setValue('knob');
    await wrapper.find('[data-test="add-component-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/components', { name: 'ROOT', type: 'knob' });
    expect(wrapper.find('[data-test="component-editor-1"]').text()).toContain('(knob)');

    await wrapper.find('[data-test="remove-component-11"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/components/11');
  });

  // Each rack is its own collapsible section, so a system of several racks
  // reads as the racks it is made of.
  it('files the modules under a collapsible section per rack', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 1,
        racks: [{ id: 1, name: 'main rack', quantity: 1 }],
        manual_status: 'found',
        analysis_status: 'complete',
      },
      {
        id: 2,
        manufacturer: 'ALM',
        name: 'Pam',
        quantity: 1,
        racks: [{ id: 2, name: 'travel case', quantity: 1 }],
        manual_status: 'pending',
        analysis_status: 'pending',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    const main = wrapper.find('[data-test="rack-group-1"]');
    const travel = wrapper.find('[data-test="rack-group-2"]');
    expect(main.text()).toContain('main rack');
    expect(main.find('[data-test="module-1"]').exists()).toBe(true);
    expect(main.find('[data-test="module-2"]').exists()).toBe(false);
    expect(travel.find('[data-test="module-2"]').exists()).toBe(true);
    // The first rack starts open; the rest are one click away.
    expect(main.attributes('open')).toBeDefined();
    expect(travel.attributes('open')).toBeUndefined();
  });

  // Typing narrows the visible rows by manufacturer or module name, and empties
  // the racks that no longer have anything to show.
  it('filters the visible modules by name or manufacturer', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 1,
        racks: [{ id: 1, name: 'main rack', quantity: 1 }],
        manual_status: 'found',
        analysis_status: 'complete',
      },
      {
        id: 2,
        manufacturer: 'ALM',
        name: 'Pamela New Workout',
        quantity: 1,
        racks: [{ id: 2, name: 'travel case', quantity: 1 }],
        manual_status: 'pending',
        analysis_status: 'pending',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();

    // By module name.
    await wrapper.find('[data-test="module-filter"]').setValue('maths');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="module-2"]').exists()).toBe(false);
    // The rack left with nothing drops out rather than showing as empty.
    expect(wrapper.find('[data-test="rack-group-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="filter-count"]').text()).toContain('1 of 2 modules');

    // By manufacturer, case-insensitively.
    await wrapper.find('[data-test="module-filter"]').setValue('alm');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="module-2"]').exists()).toBe(true);

    // Several words all have to match, across the two fields.
    await wrapper.find('[data-test="module-filter"]').setValue('make maths');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(true);

    // Nothing matching says so instead of showing empty racks.
    await wrapper.find('[data-test="module-filter"]').setValue('erica');
    expect(wrapper.find('[data-test="no-matches"]').exists()).toBe(true);

    // And clearing puts everything back.
    await wrapper.find('[data-test="clear-filter"]').trigger('click');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="module-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="filter-count"]').exists()).toBe(false);
    // Filtering is local — it does not re-ask the server.
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('narrows the list to the selected rack', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(2);
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/modules?rack_id=2');
  });

  it('moves a module to another rack from the rack-scoped view', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.post.mockResolvedValue({ ok: true });
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    await wrapper.find('[data-test="move-1"]').setValue(2);
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks/1/modules/1/move', { to_rack_id: 2 });
  });

  it('deletes a module after confirmation, scoped to the selected rack', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="module-1"] button.danger').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1');

    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    await wrapper.find('[data-test="module-1"] button.danger').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1?rack_id=1');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(false);
    vi.restoreAllMocks();
  });
});
