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

  it('offers the channel video scan only when a rack is selected', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="channel-scan"]').exists()).toBe(false);
    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    expect(wrapper.find('[data-test="channel-scan"]').exists()).toBe(true);
  });

  // Letting the module go again puts the count back to plain text: nothing
  // typed there survives to surprise the next move.
  it('takes the count box away when the module is unpicked', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'ALM',
        name: 'Pam',
        quantity: 3,
        racks: [{ id: 1, name: 'main rack', quantity: 3 }],
        manual_status: 'pending',
        analysis_status: 'pending',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    await wrapper.find('[data-test="select-1-1"]').setValue(true);
    await wrapper.find('[data-test="move-qty-1"]').setValue('1');
    await wrapper.find('[data-test="select-1-1"]').setValue(false);
    expect(wrapper.find('[data-test="move-qty-1"]').exists()).toBe(false);
  });

  it('deletes a module after confirmation, scoped to the selected rack', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    // The button says what it does — it is the one way to get a module out
    // of a rack now that the per-row move dropdown is gone.
    expect(wrapper.find('[data-test="delete-1"]').text()).toBe('Delete module');
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

// Reorganizing a case means moving several modules at once, per rack group —
// a module in two racks is ticked under the rack you are moving it out of.
describe('ModulesView bulk move', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 2 },
    { id: 2, name: 'travel case', module_count: 0 },
  ];
  const modulesResponse = [
    {
      id: 10,
      manufacturer: 'Make Noise',
      name: 'Maths',
      quantity: 1,
      racks: [{ id: 1, name: 'main rack', quantity: 1 }],
      manual_status: 'found',
      analysis_status: 'complete',
      panel_status: 'complete',
    },
    {
      id: 11,
      manufacturer: 'ALM',
      name: 'Pam',
      quantity: 1,
      racks: [{ id: 1, name: 'main rack', quantity: 1 }],
      manual_status: 'found',
      analysis_status: 'complete',
      panel_status: 'complete',
    },
    {
      id: 12,
      manufacturer: 'Mutable',
      name: 'Plaits',
      quantity: 1,
      racks: [{ id: 2, name: 'travel case', quantity: 1 }],
      manual_status: 'found',
      analysis_status: 'complete',
      panel_status: 'complete',
    },
  ];

  function mountView() {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : modulesResponse)
    );
    return mount(ModulesView, { global: testGlobal() });
  }

  it('moves the ticked modules to the chosen rack in one request', async () => {
    const wrapper = mountView();
    await flushPromises();
    api.post.mockResolvedValue({ ok: true, moved: 2, copies: 2, to_rack_id: 2 });

    await wrapper.find('[data-test="select-1-10"]').setValue(true);
    await wrapper.find('[data-test="select-1-11"]').setValue(true);
    expect(wrapper.find('[data-test="bulk-move-1"]').text()).toContain('2 selected');

    await wrapper.find('[data-test="bulk-target-1"]').setValue('2');
    await wrapper.find('[data-test="bulk-move-go-1"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/racks/1/modules/move', {
      to_rack_id: 2,
      module_ids: [10, 11],
      quantities: { 10: 1, 11: 1 },
    });
    expect(wrapper.find('[data-test="move-notice"]').text()).toContain(
      "Moved 2 copies of 2 module(s) from 'main rack' to 'travel case'"
    );
    // The selection is emptied, so the next move does not repeat this one.
    expect(wrapper.find('[data-test="bulk-move-1"]').text()).toContain('0 selected');
  });

  it('will not move with nothing ticked or nowhere to move to', async () => {
    const wrapper = mountView();
    await flushPromises();
    const button = wrapper.find('[data-test="bulk-move-go-1"]');
    expect(button.attributes('disabled')).toBeDefined();

    // A target with no selection is still not a move.
    await wrapper.find('[data-test="bulk-target-1"]').setValue('2');
    expect(wrapper.find('[data-test="bulk-move-go-1"]').attributes('disabled')).toBeDefined();

    // …and a selection with no target is not one either.
    await wrapper.find('[data-test="bulk-target-1"]').setValue('');
    await wrapper.find('[data-test="select-1-10"]').setValue(true);
    expect(wrapper.find('[data-test="bulk-move-go-1"]').attributes('disabled')).toBeDefined();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('ticks and unticks a whole rack at once', async () => {
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-test="select-all-1"]').setValue(true);
    expect(wrapper.find('[data-test="bulk-move-1"]').text()).toContain('2 selected');
    // The travel case has its own selection, untouched by the other group's.
    expect(wrapper.find('[data-test="bulk-move-2"]').text()).toContain('0 selected');

    await wrapper.find('[data-test="select-all-1"]').setValue(false);
    expect(wrapper.find('[data-test="bulk-move-1"]').text()).toContain('0 selected');
  });

  it('keeps each rack’s selection to itself', async () => {
    const wrapper = mountView();
    await flushPromises();
    api.post.mockResolvedValue({ ok: true, moved: 1, to_rack_id: 1 });

    await wrapper.find('[data-test="select-1-10"]').setValue(true);
    await wrapper.find('[data-test="select-2-12"]').setValue(true);
    await wrapper.find('[data-test="bulk-target-2"]').setValue('1');
    await wrapper.find('[data-test="bulk-move-go-2"]').trigger('click');
    await flushPromises();

    // Only the travel case's own tick travels, out of the travel case.
    expect(api.post).toHaveBeenCalledWith('/api/racks/2/modules/move', {
      to_rack_id: 1,
      module_ids: [12],
      quantities: { 12: 1 },
    });
  });

  // Each ticked module carries its own count, so a rack can send two of one
  // module, one of another, and keep the rest.
  it('sends the count typed against each ticked module', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/racks'
          ? racksResponse
          : [
              { ...modulesResponse[0], quantity: 3, racks: [{ id: 1, name: 'main rack', quantity: 3 }] },
              modulesResponse[1],
            ]
      )
    );
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    api.post.mockResolvedValue({ ok: true, moved: 2, copies: 3, to_rack_id: 2 });

    await wrapper.find('[data-test="select-all-1"]').setValue(true);
    // Ticking fills each box with what the rack holds of that module.
    expect(wrapper.find('[data-test="move-qty-10"]').element.value).toBe('3');
    expect(wrapper.find('[data-test="move-qty-11"]').element.value).toBe('1');
    await wrapper.find('[data-test="move-qty-10"]').setValue('2');

    await wrapper.find('[data-test="bulk-target-1"]').setValue('2');
    await wrapper.find('[data-test="bulk-move-go-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks/1/modules/move', {
      to_rack_id: 2,
      module_ids: [10, 11],
      quantities: { 10: 2, 11: 1 },
    });
    expect(wrapper.find('[data-test="move-notice"]').text()).toContain('Moved 3 copies of 2');
  });

  it('refuses a bulk move whose count is more than the rack holds', async () => {
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-test="select-1-10"]').setValue(true);
    await wrapper.find('[data-test="move-qty-10"]').setValue('4');
    await wrapper.find('[data-test="bulk-target-1"]').setValue('2');
    await wrapper.find('[data-test="bulk-move-go-1"]').trigger('click');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('p.error').text()).toContain('between 1 and 1');
  });

  it('reports what the server refused and leaves the selection alone', async () => {
    const wrapper = mountView();
    await flushPromises();
    api.post.mockRejectedValue(new Error('1 of the selected module(s) are not in this rack'));

    await wrapper.find('[data-test="select-1-10"]').setValue(true);
    await wrapper.find('[data-test="bulk-target-1"]').setValue('2');
    await wrapper.find('[data-test="bulk-move-go-1"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('.error').text()).toContain('not in this rack');
    // Still ticked, so the user can correct the selection and try again.
    expect(wrapper.find('[data-test="bulk-move-1"]').text()).toContain('1 selected');
  });

  it('offers no bulk move when there is nowhere to move to', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? [racksResponse[0]] : modulesResponse.slice(0, 2))
    );
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="bulk-move-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="select-1-10"]').exists()).toBe(false);
  });
});
