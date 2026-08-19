import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: {} }) };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import SystemsView from '../../src/views/SystemsView.vue';

beforeEach(() => vi.clearAllMocks());

describe('SystemsView', () => {
  const systemsResponse = [
    { id: 1, name: 'studio', description: 'the desk', rack_count: 2, module_count: 9 },
    { id: 2, name: 'live rig', rack_count: 0, module_count: 0 },
  ];

  // GET /api/systems/1 — two racks placed on the floor plan, one rack loose.
  const planResponse = {
    id: 1,
    name: 'studio',
    rack_count: 2,
    module_count: 9,
    racks: [
      {
        id: 10,
        name: 'left case',
        module_count: 1,
        system_x: 0,
        system_y: 0,
        rows: [
          {
            id: 100,
            unit: 3,
            hp: 84,
            modules: [
              { id: 1000, module_id: 500, manufacturer: 'Make Noise', name: 'Maths', hp: 20, panel: null },
            ],
          },
        ],
      },
      { id: 11, name: 'right case', module_count: 1, system_x: 90, system_y: 0, rows: [] },
    ],
    unassigned_racks: [{ id: 12, name: 'skiff', module_count: 2, rows: [] }],
  };

  function mockPlan() {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/systems' ? systemsResponse : structuredClone(planResponse)
      )
    );
  }

  it('lists systems with their rack and module counts, and creates one', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.post.mockResolvedValue({ id: 3, name: 'bench' });
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="system-1"]');
    expect(row.text()).toContain('studio');
    expect(row.text()).toContain('the desk');
    expect(row.text()).toContain('9');

    await wrapper.find('[data-test="new-system"]').setValue('bench');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/systems', {
      name: 'bench',
      description: undefined,
    });
  });

  it('renames a system', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.put.mockResolvedValue({ id: 1, name: 'the desk' });
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rename-1"]').trigger('click');
    await wrapper.find('[data-test="rename-input-1"]').setValue('the desk');
    await wrapper.find('[data-test="system-1"] form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/systems/1', { name: 'the desk' });
  });

  it('warns that deleting a system keeps its racks', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-1"]').trigger('click');
    await flushPromises();
    expect(confirm.mock.calls[0][0].message).toContain('rack(s) are kept');
    expect(api.delete).toHaveBeenCalledWith('/api/systems/1');
    expect(wrapper.find('[data-test="system-1"]').exists()).toBe(false);
  });

  it('opens the floor plan, drawing each rack to scale with its rows', async () => {
    mockPlan();
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/systems/1');
    const left = wrapper.find('[data-test="plan-rack-10"]');
    // The left case stands at the origin and is as wide as its 84HP row.
    expect(left.attributes('style')).toContain('left: 0px');
    expect(left.attributes('style')).toContain('width: 336px');
    // The right case is 90HP across the floor from it.
    expect(wrapper.find('[data-test="plan-rack-11"]').attributes('style')).toContain('left: 360px');
    expect(left.text()).toContain('left case');
  });

  it('saves a new position when a rack is dragged across the plan', async () => {
    mockPlan();
    api.put.mockResolvedValue({ racks: [] });
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    const rack = wrapper.find('[data-test="plan-rack-10"]');
    rack.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
    await rack.trigger('dragstart', { clientX: 0, clientY: 0 });
    const floor = wrapper.find('[data-test="plan-floor"]');
    floor.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
    // 200px across and 78px down: 50HP and 3U at the plan's scale.
    await floor.trigger('drop', { clientX: 200, clientY: 78 });
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/systems/1/layout', {
      racks: [
        { rack_id: 10, x: 50, y: 3 },
        { rack_id: 11, x: 90, y: 0 },
      ],
    });
  });

  it('adds a loose rack to the system and takes one back out', async () => {
    mockPlan();
    api.put.mockResolvedValue({ id: 12, name: 'skiff', system_id: 1 });
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-test="assign-12"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/12/system', { system_id: 1 });

    await wrapper.find('[data-test="unassign-10"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/10/system', { system_id: null });
  });

  it('reports what the server refused and reloads the stored arrangement', async () => {
    mockPlan();
    api.put.mockRejectedValue(new Error('rack coordinates must be between 0 and 5000'));
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    const rack = wrapper.find('[data-test="plan-rack-10"]');
    rack.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
    await rack.trigger('dragstart', { clientX: 0, clientY: 0 });
    const floor = wrapper.find('[data-test="plan-floor"]');
    floor.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
    await floor.trigger('drop', { clientX: 40, clientY: 0 });
    await flushPromises();

    expect(wrapper.find('[data-test="error"]').text()).toContain('coordinates');
    // The plan is re-read, so the rack snaps back to where it really stands.
    expect(wrapper.find('[data-test="plan-rack-10"]').attributes('style')).toContain('left: 0px');
  });
});
