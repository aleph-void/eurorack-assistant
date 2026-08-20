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
    { id: 1, name: 'main rack', module_count: 3, system_id: 7 },
    { id: 2, name: 'travel case', module_count: 1, system_id: null },
  ];
  const systemsResponse = [
    { id: 7, name: 'studio', rack_count: 1, module_count: 3 },
    { id: 8, name: 'live rig', rack_count: 0, module_count: 0 },
  ];

  // The view loads racks and systems together; a bare mockResolvedValue would
  // hand the rack list back for both.
  function mockLists(racks = racksResponse) {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/systems' ? systemsResponse : racks)
    );
  }

  it('lists racks with module counts and creates a new one', async () => {
    mockLists();
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
        rows: [{ id: 9, unit: 3, hp: 84, modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, panel: { url: '/api/panels/arp.svg', crop: { x: 0.1, y: 0, w: 0.5, h: 1 } } }] }],
      });
    });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();
    const row = wrapper.find('[data-test="rack-row-0"]');
    expect(row.find('img').attributes('src')).toBe('/api/panels/arp.svg');
    expect(row.find('.placed-module').attributes('style')).toContain('--module-hp: 2');
    // Only the front plate is drawn: the picture is blown up by its crop and
    // slid under the box, so the photo's blank backdrop stays outside it.
    expect(row.find('img').attributes('style')).toContain('width: 200%');
    expect(row.find('img').attributes('style')).toContain('left: -20%');
  });

  it('draws every module from one scale — HP across, rack units down', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      return Promise.resolve({
        id: 1,
        name: 'main rack',
        modules: [
          { id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, quantity: 1, panel: { url: '/api/panels/arp.svg' } },
          { id: 5, manufacturer: 'Make Noise', name: 'Maths', hp: 20, quantity: 1, panel: null },
        ],
        rows: [
          { id: 9, unit: 3, hp: 84, modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, panel: { url: '/api/panels/arp.svg' } }] },
          { id: 10, unit: 1, hp: 84, modules: [] },
        ],
      });
    });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();

    // A row is as tall as its unit count; a module as wide as its HP. Both
    // come from the same scale, so the panels keep their real proportions.
    expect(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').attributes('style'))
      .toContain('--row-units: 3');
    expect(wrapper.find('[data-test="rack-row-1"] .rack-row-slots').attributes('style'))
      .toContain('--row-units: 1');
    // Inventory chips are the same picture drawn small — HP-wide too, so a
    // 2HP module does not sit in the list looking like a 20HP one.
    expect(wrapper.find('[data-test="available-module-5-0"]').attributes('style'))
      .toContain('--module-hp: 20');
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

  // Two copies of the same module in one row, plus a third module, so a
  // reorder has to move the RIGHT copy rather than the first match by id.
  function reorderableDetail() {
    const arp = { module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2 };
    const maths = { module_id: 5, manufacturer: 'Make Noise', name: 'Maths', hp: 20 };
    return {
      id: 1,
      name: 'main rack',
      modules: [
        { id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, quantity: 2 },
        { id: 5, manufacturer: 'Make Noise', name: 'Maths', hp: 20, quantity: 1 },
      ],
      rows: [{ id: 9, unit: 3, hp: 84, modules: [{ ...arp }, { ...maths }, { ...arp }] }],
    };
  }

  // The layout PUT is the source of truth for order, so echo the saved row
  // back the way the server would and the rendered row follows it.
  function echoLayout(detail) {
    const byId = new Map(detail.modules.map((module) => [module.id, module]));
    api.put.mockImplementation((path, body) =>
      Promise.resolve({
        rows: body.rows.map((row, index) => ({
          ...detail.rows[index],
          unit: row.unit,
          hp: row.hp,
          modules: row.modules.map(({ module_id: id }) => ({
            module_id: id,
            manufacturer: byId.get(id).manufacturer,
            name: byId.get(id).name,
            hp: byId.get(id).hp,
          })),
        })),
      })
    );
  }

  // jsdom lays nothing out, so give each slot the box it would really have:
  // 2HP, 20HP, 2HP at 9px per HP, laid end to end.
  function measureSlots(wrapper, widths) {
    let left = 0;
    for (const [index, slot] of wrapper.findAll('.placed-module').entries()) {
      const box = { left, width: widths[index], right: left + widths[index], top: 0, bottom: 100, height: 100 };
      slot.element.getBoundingClientRect = () => box;
      left += widths[index];
    }
  }

  async function openReorderable(attachTo) {
    const detail = reorderableDetail();
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : reorderableDetail())
    );
    echoLayout(detail);
    const wrapper = mount(RacksView, { global: testGlobal(), ...(attachTo ? { attachTo } : {}) });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  const placedNames = (wrapper) =>
    wrapper.findAll('.placed-module').map((slot) => slot.attributes('aria-label').split(',')[0]);

  it('drops a module between two others instead of appending it', async () => {
    const wrapper = await openReorderable();
    measureSlots(wrapper, [18, 180, 18]);
    const slots = wrapper.find('[data-test="rack-row-0"] .rack-row-slots');

    // Picked up the trailing ARP, aimed at the left half of Maths: it lands
    // between the two, not back on the end.
    await wrapper.find('[data-test="placed-module-0-2"]').trigger('dragstart');
    await slots.trigger('dragover', { clientX: 30 });
    expect(wrapper.find('[data-test="placed-module-0-1"]').classes()).toContain('drop-before');
    await slots.trigger('drop', { clientX: 30 });
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }, { module_id: 4 }, { module_id: 5 }] }],
    });
    expect(placedNames(wrapper)).toEqual(['2hp ARP', '2hp ARP', 'Make Noise Maths']);
  });

  it('leaves the row alone when a module is dropped back where it started', async () => {
    const wrapper = await openReorderable();
    measureSlots(wrapper, [18, 180, 18]);
    const slots = wrapper.find('[data-test="rack-row-0"] .rack-row-slots');
    await wrapper.find('[data-test="placed-module-0-0"]').trigger('dragstart');
    await slots.trigger('drop', { clientX: 5 });
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('steps the focused module along its row with the arrow keys', async () => {
    const wrapper = await openReorderable(document.body);
    await wrapper.find('[data-test="placed-module-0-0"]').trigger('keydown.right');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 5 }, { module_id: 4 }, { module_id: 4 }] }],
    });
    expect(placedNames(wrapper)).toEqual(['Make Noise Maths', '2hp ARP', '2hp ARP']);
    // Focus follows the module that moved, so it can be stepped again.
    expect(document.activeElement).toBe(wrapper.find('[data-test="placed-module-0-1"]').element);

    await wrapper.find('[data-test="placed-module-0-0"]').trigger('keydown.left');
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('renames a rack', async () => {
    mockLists();
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
    mockLists();
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
    mockLists();
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

describe('RacksView systems', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3, system_id: 7 },
    { id: 2, name: 'travel case', module_count: 1, system_id: null },
  ];
  const systemsResponse = [
    { id: 7, name: 'studio', rack_count: 1, module_count: 3 },
    { id: 8, name: 'live rig', rack_count: 0, module_count: 0 },
  ];

  function mount_() {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/systems' ? systemsResponse : racksResponse)
    );
    return mount(RacksView, { global: testGlobal() });
  }

  it('shows which system each rack is in', async () => {
    const wrapper = mount_();
    await flushPromises();
    expect(wrapper.find('[data-test="system-1"]').element.value).toBe('7');
    // A rack in no system shows the blank option.
    expect(wrapper.find('[data-test="system-2"]').element.value).toBe('');
  });

  it('puts a rack into a system and takes it out again', async () => {
    api.put.mockResolvedValue({ id: 2, name: 'travel case', system_id: 8 });
    const wrapper = mount_();
    await flushPromises();

    await wrapper.find('[data-test="system-2"]').setValue('8');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/2/system', { system_id: 8 });

    await wrapper.find('[data-test="system-1"]').setValue('');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/system', { system_id: null });
  });

  it('reports a refused assignment', async () => {
    api.put.mockRejectedValue(new Error('System not found'));
    const wrapper = mount_();
    await flushPromises();
    await wrapper.find('[data-test="system-2"]').setValue('8');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('System not found');
  });
});
