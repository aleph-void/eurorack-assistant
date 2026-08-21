import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';
import { clearToasts, toastState } from '../../src/toast.js';

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
  clearToasts();
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

  // The organizer drags with plain mouse events, so a gesture is a press, a
  // move past the threshold, and a release. jsdom lays nothing out and has no
  // elementFromPoint, so what the cursor is over has to be said outright.
  const over = (element) => {
    document.elementFromPoint = () => element;
  };
  const mouse = (type, clientX = 0, clientY = 0) =>
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }));

  async function pickUp(source, clientX = 0, clientY = 0) {
    await source.trigger('mousedown', { button: 0, clientX, clientY });
    mouse('mousemove', clientX + 20, clientY);
  }

  async function dropAt(clientX = 0, clientY = 0) {
    mouse('mousemove', clientX, clientY);
    mouse('mouseup', clientX, clientY);
    await flushPromises();
  }

  afterEach(() => {
    delete document.elementFromPoint;
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
    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    await pickUp(wrapper.find('[data-test="available-module-4-0"]'));
    await dropAt(40, 10);
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
    // Saving REPLACES the rack's rows, so every save hands back rows with
    // brand new ids — nothing on the page may identify a row by its id.
    let nextRowId = 100;
    api.put.mockImplementation((path, body) =>
      Promise.resolve({
        rows: body.rows.map((row, index) => ({
          ...detail.rows[index],
          id: nextRowId++,
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
    over(slots.element);
    await pickUp(wrapper.find('[data-test="placed-module-0-2"]'), 200);
    mouse('mousemove', 30, 10);
    await flushPromises();
    expect(wrapper.find('[data-test="placed-module-0-1"]').classes()).toContain('drop-before');
    // The slot the module came out of stays in the row, dimmed, so the row
    // does not close up under the cursor mid-aim.
    expect(wrapper.find('[data-test="placed-module-0-2"]').classes()).toContain('in-hand');
    await dropAt(30, 10);

    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }, { module_id: 4 }, { module_id: 5 }] }],
    });
    expect(placedNames(wrapper)).toEqual(['2hp ARP', '2hp ARP', 'Make Noise Maths']);
  });

  it('leaves the row alone when a module is dropped back where it started', async () => {
    const wrapper = await openReorderable();
    measureSlots(wrapper, [18, 180, 18]);
    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    await pickUp(wrapper.find('[data-test="placed-module-0-0"]'), 5);
    await dropAt(5, 10);
    expect(api.put).not.toHaveBeenCalled();
  });

  // A press with no travel is a click, not a gesture: the alt-click that
  // removes a placement, and the focus the arrow keys step from, both still
  // have to work.
  it('does not pick a module up until the cursor has actually moved', async () => {
    const wrapper = await openReorderable();
    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    await wrapper.find('[data-test="placed-module-0-0"]').trigger('mousedown', { button: 0, clientX: 5, clientY: 5 });
    mouse('mousemove', 7, 6);
    expect(wrapper.find('[data-test="drag-ghost"]').exists()).toBe(false);
    mouse('mouseup', 7, 6);
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
  });

  // Escape is the one thing a native drag gave for free.
  it('puts the module back where it was on Escape', async () => {
    const wrapper = await openReorderable();
    measureSlots(wrapper, [18, 180, 18]);
    const slots = wrapper.find('[data-test="rack-row-0"] .rack-row-slots');
    over(slots.element);
    await pickUp(wrapper.find('[data-test="placed-module-0-2"]'), 200);
    mouse('mousemove', 30, 10);
    await flushPromises();
    expect(wrapper.find('[data-test="drag-ghost"]').exists()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flushPromises();
    expect(wrapper.find('[data-test="drag-ghost"]').exists()).toBe(false);
    // A release afterwards is not a drop that has been left over.
    await dropAt(30, 10);
    expect(api.put).not.toHaveBeenCalled();
    expect(placedNames(wrapper)).toEqual(['2hp ARP', 'Make Noise Maths', '2hp ARP']);
  });

  it('drags a placed module back out to the available list', async () => {
    const wrapper = await openReorderable();
    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    await pickUp(wrapper.find('[data-test="placed-module-0-1"]'), 100);
    over(wrapper.find('[data-test="available-modules"]').element);
    await dropAt(10, 400);
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }, { module_id: 4 }] }],
    });
  });

  it('removes a row and saves the rows that are left', async () => {
    const wrapper = await openReorderable();
    await wrapper.find('[data-test="remove-row-0"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', { rows: [] });
    expect(wrapper.findAll('.rack-row')).toHaveLength(0);
  });

  // Saving REPLACES the rack's rows, so two saves in flight at once are what
  // left a rack holding two copies of every row. Whatever the organizer is
  // asked to do, only one save is ever in the air.
  it('never has two layout saves in flight at once', async () => {
    const wrapper = await openReorderable();
    let settle;
    api.put.mockImplementation(() => new Promise((resolve) => { settle = () => resolve({ rows: [] }); }));

    // A held arrow key: three saves asked for before the first one lands.
    const module = wrapper.find('[data-test="placed-module-0-0"]');
    await module.trigger('keydown.right');
    await module.trigger('keydown.right');
    await module.trigger('keydown.right');
    expect(api.put).toHaveBeenCalledTimes(1);

    // The ones asked for meanwhile are made as ONE save afterwards, from the
    // layout as it stands by then.
    settle();
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  // A rack whose STORED layout already places a module more often than the
  // rack holds it (duplicated rows, from two saves racing before the
  // organizer saved one at a time) is refused by the server on every save.
  // The organizer says which module is over-placed instead of spending a
  // round trip to be told, and the rows stay as edited so the duplicates can
  // actually be removed.
  it('refuses to save an over-placed layout, and saves once it is repaired', async () => {
    const doubled = {
      id: 1,
      name: 'mega rack',
      modules: [{ id: 4, manufacturer: '2hp', name: 'ARP', hp: 2, quantity: 1 }],
      rows: [
        { id: 9, unit: 3, hp: 84, modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2 }] },
        { id: 10, unit: 3, hp: 84, modules: [{ module_id: 4, manufacturer: '2hp', name: 'ARP', hp: 2 }] },
      ],
    };
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/racks' ? racksResponse : doubled));
    api.put.mockResolvedValue({ rows: [doubled.rows[0]] });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();

    // Adding a row is enough to try a save, and it is stopped before the wire.
    await wrapper.find('[data-test="add-1u-row"]').trigger('click');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="layout-error"]').text()).toContain('2hp ARP (2 placed, 1 in the rack)');
    // The added row is still on screen: a refused save keeps the edit.
    expect(wrapper.findAll('.rack-row')).toHaveLength(3);

    // Take the duplicate away and the whole layout saves itself.
    await wrapper.find('[data-test="remove-row-1"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }] }, { unit: 1, hp: 84, modules: [] }],
    });
    expect(wrapper.find('[data-test="layout-error"]').exists()).toBe(false);
  });

  // Reloading the stored layout after a refusal used to undo the edit as
  // well, which is what made a rack in that state impossible to repair.
  it('keeps the rows on screen when the server refuses the save', async () => {
    const wrapper = await openReorderable();
    api.put.mockRejectedValue(new Error('row 1 exceeds its 84HP capacity'));
    api.get.mockClear();
    await wrapper.find('[data-test="remove-row-0"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="layout-error"]').text()).toContain('not saved');
    expect(api.get).not.toHaveBeenCalled();
    expect(wrapper.findAll('.rack-row')).toHaveLength(0);
  });

  // The refusal that started all this: a module dropped into a row with no
  // room left for it. The organizer is a long page, so saying it only in the
  // panel beside the rows is saying it where the user is not looking.
  it('says why a module would not fit, over the page as well as beside the rows', async () => {
    const detail = {
      id: 1,
      name: 'main rack',
      modules: [{ id: 5, manufacturer: 'Make Noise', name: 'Maths', hp: 20, quantity: 1 }],
      rows: [{ id: 9, unit: 3, hp: 4, modules: [] }],
    };
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/racks' ? racksResponse : detail));
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();

    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    await pickUp(wrapper.find('[data-test="available-module-5-0"]'));
    await dropAt(40, 10);

    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="layout-error"]').text()).toContain('does not fit in this 4HP row');
    expect(toastState.items[0].kind).toBe('error');
    expect(toastState.items[0].message).toContain('Make Noise Maths (20HP) does not fit');
  });

  // The reason the drag is not a native HTML5 one: a native drag is a modal
  // gesture that swallows the wheel outright, so a row further down cannot be
  // reached with a module in hand. Following the mouse ourselves leaves the
  // wheel an ordinary event the view can take for the length of the gesture.
  it('scrolls the page with the wheel while a module is being dragged', async () => {
    const wrapper = await openReorderable();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    over(wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element);
    const wheel = (init = {}) => {
      const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, ...init });
      window.dispatchEvent(event);
      return event;
    };

    // Empty-handed the wheel is the browser's business.
    wheel();
    expect(scrollBy).not.toHaveBeenCalled();

    await pickUp(wrapper.find('[data-test="placed-module-0-0"]'), 5);
    const event = wheel();
    expect(scrollBy).toHaveBeenCalledWith(0, 120);
    expect(event.defaultPrevented).toBe(true);

    // And it is handed back the moment the module is put down.
    await dropAt(5, 10);
    wheel();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    scrollBy.mockRestore();
  });

  it('slides a row wider than its box along on a shift-wheel mid-drag', async () => {
    const wrapper = await openReorderable();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const row = wrapper.find('[data-test="rack-row-0"] .rack-row-slots').element;
    Object.defineProperty(row, 'scrollLeft', { value: 0, writable: true });
    over(row);

    await pickUp(wrapper.find('[data-test="placed-module-0-0"]'), 5);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 90, shiftKey: true, cancelable: true }));
    expect(row.scrollLeft).toBe(90);
    expect(scrollBy).not.toHaveBeenCalled();

    // Without shift the page moves instead, even over a row.
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 90, cancelable: true }));
    expect(row.scrollLeft).toBe(90);
    expect(scrollBy).toHaveBeenCalledWith(0, 90);
    scrollBy.mockRestore();
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

  it('pulls a module off the row with alt-click or right-click', async () => {
    const wrapper = await openReorderable();

    // Alt-click removes the trailing ARP; the other copy of it stays put.
    await wrapper.find('[data-test="placed-module-0-2"]').trigger('click', { altKey: true });
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }, { module_id: 5 }] }],
    });
    expect(placedNames(wrapper)).toEqual(['2hp ARP', 'Make Noise Maths']);

    // Right-click takes the next one the same way.
    await wrapper.find('[data-test="placed-module-0-1"]').trigger('contextmenu');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/layout', {
      rows: [{ unit: 3, hp: 84, modules: [{ module_id: 4 }] }],
    });
    expect(placedNames(wrapper)).toEqual(['2hp ARP']);
  });

  it('leaves the row alone on a plain click', async () => {
    const wrapper = await openReorderable();
    await wrapper.find('[data-test="placed-module-0-0"]').trigger('click');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(placedNames(wrapper)).toHaveLength(3);
  });

  it('opens the organizer with every row collapsed, and expands one on demand', async () => {
    const wrapper = await openReorderable();
    const strip = () => wrapper.find('[data-test="rack-row-0"] .rack-row-slots');
    const toggle = () => wrapper.find('[data-test="row-collapse-0"]');
    const hidden = () => (strip().attributes('style') || '').includes('display: none');
    // Folded away on load, but still in the DOM (v-show), and nothing was
    // saved: collapsing is view state, not layout.
    expect(strip().exists()).toBe(true);
    expect(hidden()).toBe(true);
    expect(toggle().attributes('aria-expanded')).toBe('false');
    expect(api.put).not.toHaveBeenCalled();

    await toggle().trigger('click');
    expect(hidden()).toBe(false);
    expect(toggle().attributes('aria-expanded')).toBe('true');

    await toggle().trigger('click');
    expect(hidden()).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  });

  // Every save re-creates the rack's rows with new ids, so a collapsed row
  // that was identified by its id sprang open again after each drop.
  it('keeps a row collapsed across a layout save', async () => {
    const wrapper = await openReorderable();
    const collapsed = (index) =>
      wrapper.find(`[data-test="row-collapse-${index}"]`).attributes('aria-expanded') === 'false';
    expect(collapsed(0)).toBe(true);

    await wrapper.find('[data-test="add-1u-row"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.rack-row')).toHaveLength(2);
    expect(collapsed(0)).toBe(true);
    // The row just added is not folded away, or it would look like nothing
    // happened.
    expect(collapsed(1)).toBe(false);
  });

  // The flags follow the rows they belong to when one above them goes.
  it('moves a collapsed state up when the row above it is removed', async () => {
    const wrapper = await openReorderable();
    const collapsed = (index) =>
      wrapper.find(`[data-test="row-collapse-${index}"]`).attributes('aria-expanded') === 'false';
    await wrapper.find('[data-test="add-1u-row"]').trigger('click');
    await flushPromises();
    expect(collapsed(1)).toBe(false);
    await wrapper.find('[data-test="row-collapse-1"]').trigger('click');
    expect(collapsed(1)).toBe(true);

    await wrapper.findAll('.rack-row')[0].find('button.danger').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.rack-row')).toHaveLength(1);
    expect(collapsed(0)).toBe(true);
  });

  // Adding a row to a case that is 84HP wide should not have to be corrected
  // to 84HP every time.
  async function organizerWithRows(rows) {
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      return Promise.resolve({ id: 1, name: 'main rack', modules: [], rows });
    });
    api.put.mockResolvedValue({ rows });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="organize-1"]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  const addedRow = () => api.put.mock.calls[0][1].rows.at(-1);

  it('collapses every row of a multi-row rack on load', async () => {
    const wrapper = await organizerWithRows([
      { id: 9, unit: 3, hp: 84, modules: [] },
      { id: 10, unit: 1, hp: 84, modules: [] },
    ]);
    const toggles = wrapper.findAll('[data-test^="row-collapse-"]');
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) expect(toggle.attributes('aria-expanded')).toBe('false');
  });

  it('starts a new row at the width the rack is already built to', async () => {
    const wrapper = await organizerWithRows([
      { id: 9, unit: 3, hp: 84, modules: [] },
      { id: 10, unit: 1, hp: 84, modules: [] },
    ]);
    await wrapper.find('[data-test="add-3u-row"]').trigger('click');
    await flushPromises();
    expect(addedRow()).toEqual({ unit: 3, hp: 84, modules: [] });
  });

  it('falls back to a default width for the first row, or rows that disagree', async () => {
    const empty = await organizerWithRows([]);
    await empty.find('[data-test="add-3u-row"]').trigger('click');
    await flushPromises();
    expect(addedRow()).toEqual({ unit: 3, hp: 104, modules: [] });

    vi.clearAllMocks();
    const mixed = await organizerWithRows([
      { id: 9, unit: 3, hp: 84, modules: [] },
      { id: 10, unit: 3, hp: 60, modules: [] },
    ]);
    await mixed.find('[data-test="add-1u-row"]').trigger('click');
    await flushPromises();
    expect(addedRow()).toEqual({ unit: 1, hp: 104, modules: [] });
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
