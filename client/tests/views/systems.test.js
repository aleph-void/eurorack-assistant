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
    floor_width: 140,
    floor_height: 9,
    racks: [
      {
        id: 10,
        name: 'left case',
        module_count: 1,
        system_x: 0,
        system_y: 0,
        width_hp: 84,
        height_u: 3,
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
      {
        id: 11,
        name: 'right case',
        module_count: 1,
        system_x: 90,
        system_y: 0,
        width_hp: 84,
        height_u: 3,
        rows: [],
      },
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

  it('queues one background sweep to trim every panel in a system', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.post.mockResolvedValue({ id: 7, type: 'trim_panels', status: 'pending', reused: false });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    // A system with no modules has nothing to trim.
    expect(wrapper.find('[data-test="trim-panels-2"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test="trim-panels-1"]').trigger('click');
    await flushPromises();
    expect(confirm.mock.calls[0][0].message).toContain('cannot be undone');
    expect(api.post).toHaveBeenCalledWith('/api/systems/1/panels/trim');
    expect(wrapper.find('[data-test="notice"]').text()).toContain('runs in the background');
  });

  it('fills the gaps for a whole system in one sweep', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.post.mockResolvedValue({
      modules: 9,
      queued: { find_manual: 2, analyze_manual: 1, panel_image: 0, extract_manual: 0, describe_components: 3 },
      skipped: 1,
      complete: 3,
    });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    // A system with no modules has nothing to fill in.
    expect(wrapper.find('[data-test="fill-gaps-2"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test="fill-gaps-1"]').trigger('click');
    await flushPromises();
    expect(confirm.mock.calls[0][0].message).toContain("every module in 'studio'");
    expect(api.post).toHaveBeenCalledWith('/api/modules/reanalyze', { system_id: 1 });
    const notice = wrapper.find('[data-test="notice"]').text();
    expect(notice).toContain('Queued 6 job(s)');
    expect(notice).toContain('3 of 9 module(s) already complete');
    expect(notice).toContain('1 already had one waiting');
  });

  it('says so when a system has no gaps left to fill', async () => {
    api.get.mockResolvedValue(systemsResponse);
    api.post.mockResolvedValue({
      modules: 9,
      queued: { find_manual: 0, analyze_manual: 0, panel_image: 0, extract_manual: 0, describe_components: 0 },
      skipped: 0,
      complete: 9,
    });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="fill-gaps-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="notice"]').text()).toContain('Nothing to queue');
  });

  it('queues nothing when the fill-in is not confirmed', async () => {
    api.get.mockResolvedValue(systemsResponse);
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="fill-gaps-1"]').trigger('click');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('leaves the panels alone when the trim is not confirmed', async () => {
    api.get.mockResolvedValue(systemsResponse);
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="trim-panels-1"]').trigger('click');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
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
    // 200px across and 105px down: 50HP and 3U at the plan's scale.
    await floor.trigger('drop', { clientX: 200, clientY: 105 });
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/systems/1/layout', {
      racks: [
        { rack_id: 10, x: 50, y: 3 },
        { rack_id: 11, x: 90, y: 0 },
      ],
    });
  });

  it('never lets one rack stand on another, sliding it clear the short way', async () => {
    mockPlan();
    api.put.mockResolvedValue({ racks: [] });
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    const floor = wrapper.find('[data-test="plan-floor"]');
    floor.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
    const drag = async (clientX, clientY) => {
      const rack = wrapper.find('[data-test="plan-rack-10"]');
      rack.element.getBoundingClientRect = () => ({ left: 0, top: 0 });
      await rack.trigger('dragstart', { clientX: 0, clientY: 0 });
      await floor.trigger('drop', { clientX, clientY });
      await flushPromises();
    };
    const placed = (id) =>
      api.put.mock.calls.at(-1)[1].racks.find((rack) => rack.rack_id === id);

    // Dropped at 10 HP, the left case's right edge would cross into the
    // right case at 90. It comes to rest flush against it instead.
    await drag(40, 0);
    expect(placed(10)).toEqual({ rack_id: 10, x: 6, y: 0 });
    // The neighbour it was pushed off is left exactly where it stood.
    expect(placed(11)).toEqual({ rack_id: 11, x: 90, y: 0 });

    // Dropped squarely on top of the right case, sliding sideways is the
    // long way out and it lands in the row below instead.
    await drag(360, 0);
    expect(placed(10)).toEqual({ rack_id: 10, x: 90, y: 3 });
  });

  it('resizes the floor plan and draws it at the chosen zoom', async () => {
    mockPlan();
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    // The floor is 140 HP by 9 U, drawn at 4px per HP and 35px per U (a rack
    // unit is 8.75 HP tall) — but never smaller than the racks standing on it
    // need, and the right case ends at 174 HP.
    const floor = () => wrapper.find('[data-test="plan-floor"]').attributes('style');
    expect(floor()).toContain('width: 696px');
    expect(floor()).toContain('height: 315px');

    api.put.mockResolvedValue({ id: 1, floor_width: 224, floor_height: 9 });
    await wrapper.find('[data-test="floor-width"]').setValue(224);
    await wrapper.find('[data-test="floor-width"]').trigger('change');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/systems/1', { floor_width: 224, floor_height: 9 });
    expect(floor()).toContain('width: 896px');

    // A very wide studio is read by drawing it smaller; the coordinates
    // themselves are untouched.
    await wrapper.find('[data-test="plan-zoom"]').setValue(50);
    await flushPromises();
    expect(floor()).toContain('width: 448px');
    expect(wrapper.find('[data-test="plan-rack-11"]').attributes('style')).toContain('left: 180px');
  });

  it('resizes the floor plan by dragging its edge', async () => {
    mockPlan();
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    const floor = () => wrapper.find('[data-test="plan-floor"]').attributes('style');
    // The floor starts 174 HP wide (the right case ends there) by 9 U.
    expect(floor()).toContain('width: 696px');

    // Pulling the corner 200px right and 70px down is 50 HP and 2 U more.
    const corner = wrapper.find('[data-test="plan-resize-corner"]');
    await corner.trigger('pointerdown', { clientX: 700, clientY: 315, pointerId: 1 });
    await corner.trigger('pointermove', { clientX: 900, clientY: 385, pointerId: 1 });
    // The floor is drawn at the dragged size before anything is saved.
    expect(floor()).toContain('width: 896px');
    expect(floor()).toContain('height: 385px');
    expect(api.put).not.toHaveBeenCalled();

    api.put.mockResolvedValue({ id: 1, floor_width: 224, floor_height: 11 });
    await corner.trigger('pointerup', { clientX: 900, clientY: 385, pointerId: 1 });
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/systems/1', { floor_width: 224, floor_height: 11 });
    expect(floor()).toContain('width: 896px');
    expect(floor()).toContain('height: 385px');
  });

  it('drags only one edge at a time and never below the minimum', async () => {
    mockPlan();
    const wrapper = mount(SystemsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="arrange-1"]').trigger('click');
    await flushPromises();

    // The bottom edge sets the height alone; a pull far to the left cannot
    // take the floor below the 3 U minimum (and the racks keep it at 3 U).
    const bottom = wrapper.find('[data-test="plan-resize-bottom"]');
    api.put.mockResolvedValue({ id: 1, floor_width: 140, floor_height: 3 });
    await bottom.trigger('pointerdown', { clientX: 300, clientY: 315, pointerId: 2 });
    await bottom.trigger('pointerup', { clientX: 40, clientY: 0, pointerId: 2 });
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/systems/1', { floor_width: 140, floor_height: 3 });
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
