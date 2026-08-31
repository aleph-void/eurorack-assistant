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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/components' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleComponentsView from '../../src/views/ModuleComponentsView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule, valuesModule, conditionalModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleComponentsView', () => {
  const moduleResponse = mathsModule;

  // The chip row is how the reader gets from here to any one kind's page
  // without a trip through the drawer — which no longer lists the kinds.
  it("offers each kind's own page as a chip row, with the rack riding along", async () => {
    api.get.mockResolvedValue(moduleResponse);
    currentRouteQuery = { rack: '2' };
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // This page is every kind at once, so its own chip is the lit one.
    expect(wrapper.find('[data-test="type-nav-all"]').attributes('aria-current')).toBe('page');
    expect(wrapper.find('[data-test="type-nav-knob"]').attributes('to')).toBe(
      '/modules/1/parts/knob?rack=2'
    );
    expect(wrapper.find('[data-test="type-nav-input_jack"]').attributes('to')).toBe(
      '/modules/1/jacks/input?rack=2'
    );
    // A kind the module has none of gets no chip; its section below is still
    // where one is added by hand.
    expect(wrapper.find('[data-test="type-nav-slider"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-slider"]').exists()).toBe(true);
  });

  it('groups components by type and shows voltage ranges', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="group-input_jack"]').text()).toContain('-10V … 10V');
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('unipolar');
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('Rise');
    // The plate is only drawn while a marker is being put right on it.
    expect(wrapper.find('[data-test="arrange-panel"]').exists()).toBe(false);
  });

  it('adds and removes controls while refreshing component lists and panel markers', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    let detail = {
      ...moduleResponse,
      components: [...moduleResponse.components],
      panel: {
        source: 'image',
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        components: [
          { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 },
        ],
      },
    };
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/1' ? structuredClone(detail) : [])
    );
    api.post.mockImplementation(async () => {
      const component = { id: 4, type: 'knob', name: 'FREQUENCY', description: null };
      detail.components.push(component);
      detail.panel.components.push({
        id: 6,
        component_id: 4,
        name: 'FREQUENCY',
        shape: 'knob',
        x: 0.5,
        y: 0.8,
      });
      return { ...component, panel_placement_id: 6 };
    });
    api.delete.mockImplementation(async () => {
      detail.components = detail.components.filter((c) => c.id !== 4);
      detail.panel.components = detail.panel.components.filter((c) => c.component_id !== 4);
      return { ok: true };
    });

    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="add-new-input_jack"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-output_jack"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-knob"]').exists()).toBe(true);
    // Empty supported groups stay visible so their first component can be added.
    expect(wrapper.find('[data-test="add-new-bidirectional_jack"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-display"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-other"]').exists()).toBe(true);

    // The mult group's add form drops the parenthetical from its label.
    await wrapper.find('[data-test="add-new-bidirectional_jack"]').trigger('click');
    expect(wrapper.find('[data-test="add-form-bidirectional_jack"]').text()).toContain(
      'New bidirectional jack name'
    );

    await wrapper.find('[data-test="add-new-knob"]').trigger('click');
    await wrapper.find('[data-test="component-name"]').setValue('FREQUENCY');
    await wrapper.find('[data-test="add-form-knob"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/components', {
      name: 'FREQUENCY',
      type: 'knob',
    });
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('FREQUENCY');
    expect(wrapper.find('[data-test="group-knob"] .summary-count').text()).toBe('2');
    // The new component came back with a marker of its own, which arranging
    // it puts on the plate.
    await wrapper.find('[data-test="arrange-component-4"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="panel-marker-4"]').exists()).toBe(true);

    await wrapper.find('[data-test="remove-component-4"]').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/components/4');
    expect(wrapper.find('[data-test="group-knob"]').text()).not.toContain('FREQUENCY');
    // Removing what was being arranged puts the plate away with it.
    expect(wrapper.find('[data-test="arrange-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-knob"] .summary-count').text()).toBe('1');
  });

  it('draws the plate only while a marker is being arranged, and only that marker', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [
        { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 },
        { id: 6, component_id: 2, name: 'EOR', shape: 'jack', x: 0.6, y: 0.8 },
        { id: 7, component_id: 3, name: 'Rise', shape: 'knob', x: 0.5, y: 0.3 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // Nothing is being arranged, so the plate is not in the way of the lists.
    expect(wrapper.findAll('.marker')).toHaveLength(0);
    expect(wrapper.find('[data-test="arrange-component-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-2"]').exists()).toBe(true);
    // Knobs get the same button, so a single control can be placed on its own.
    expect(wrapper.find('[data-test="arrange-component-3"]').exists()).toBe(true);

    await wrapper.find('[data-test="arrange-component-3"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Rise');

    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('EOR');

    // The active Arranging button is itself a toggle back out of arranging.
    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="arrange-panel"]').exists()).toBe(false);

    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    await wrapper.find('[data-test="panel-disable-arranging"]').trigger('click');
    expect(wrapper.find('[data-test="arrange-panel"]').exists()).toBe(false);
  });

  // The module's own page sends a marker click here, naming the component it
  // was a question about.
  it('arranges the component the URL names', async () => {
    currentRouteQuery = { arrange: '3' };
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 7, component_id: 3, name: 'Rise', shape: 'knob', x: 0.5, y: 0.3 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Rise');
    expect(wrapper.find('[data-test="panel-marker-3"]').exists()).toBe(true);
  });

  it('scrolls to the panel when arranging, and back to the row from the marker', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleComponentsView, {
      props: { id: '1' },
      global: testGlobal(),
      attachTo: document.body,
    });
    await flushPromises();

    // Arranging brings the panel picture into view.
    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.calls[0][0]).toMatchObject({ block: 'start' });

    // A click on the marker (a press that never moves) jumps back down to
    // the component's row in the list.
    await wrapper.find('[data-test="panel-marker-1"]').trigger('pointerdown', {
      clientX: 10,
      clientY: 10,
    });
    await wrapper.find('[data-test="module-panel-svg"]').trigger('pointerup');
    await flushPromises();
    expect(scrolled).toHaveBeenCalledTimes(2);
    expect(scrolled.mock.calls[1][0]).toMatchObject({ block: 'center' });
    wrapper.unmount();
  });

  // Every component type is the same kind of thing to this page: it can be
  // added by hand, arranged on the panel, retyped and removed. Switches and
  // sliders used to be read-only leftovers of the analysis.
  it('offers Arrange, Edit and Remove on every component type', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [],
    };
    api.get.mockResolvedValue({
      ...moduleResponse,
      components: [
        { id: 4, type: 'button', name: 'Cycle', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 5, type: 'display', name: 'Level LED', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 6, type: 'toggle', name: 'Range', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 7, type: 'switch', name: 'Mode', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 8, type: 'bidirectional_jack', name: 'Mult 1', description: null, voltage_min: null, voltage_max: null, polarity: null, group_label: '1' },
      ],
      panel,
    });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    for (const id of [4, 5, 6, 7, 8]) {
      expect(wrapper.find(`[data-test="arrange-component-${id}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-test="edit-component-${id}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-test="remove-component-${id}"]`).exists()).toBe(true);
    }
    // The type is changed from the same row, whatever the row holds.
    await wrapper.find('[data-test="edit-component-7"]').trigger('click');
    expect(wrapper.find('[data-test="edit-type-7"]').exists()).toBe(true);

    // And a type the analysis found none of still gets its section, so a
    // missing slider can be added without already having one.
    expect(wrapper.find('[data-test="group-slider"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-slider"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-switch"]').exists()).toBe(true);
  });

  it('creates a panel marker when arranging an analyzed jack the image mapper missed', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [
        { id: 6, component_id: 2, name: 'EOR', shape: 'jack', x: 0.6, y: 0.8 },
      ],
    };
    const repairedPanel = {
      ...panel,
      components: [
        ...panel.components,
        { id: 8, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    api.post.mockResolvedValue({ panel: repairedPanel, placement_id: 8 });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/components', { component_id: 1 });
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(true);
  });

  // Positions are fractions of the whole image and the plate is a crop of it,
  // so a re-crop can leave a marker off the picture entirely. Arranging is
  // where a marker is put right, so it starts by bringing it back into frame.
  it('brings an out-of-frame marker back to the middle of the plate when arranging it', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0.2, y: 0.1, w: 0.4, h: 0.8 },
      components: [
        // Off the right-hand edge of the plate (0.2 → 0.6 of the image).
        { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', type: 'input_jack', x: 0.95, y: 0.5 },
        { id: 6, component_id: 2, name: 'EOR', shape: 'jack', type: 'output_jack', x: 0.4, y: 0.5 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    api.patch.mockResolvedValue({ panel });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();
    // The middle of the crop, in fractions of the whole image.
    expect(api.patch).toHaveBeenCalledWith('/api/modules/1/panel/components/5', {
      x: 0.4,
      y: 0.5,
    });
    // A marker already on the plate is left exactly where it is.
    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    await flushPromises();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('marks an output nothing feeds as a generator', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, routes: [] });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('generator');
  });

  it('names the inputs that reach an output', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      routes: [{ id: 7, input_component_id: 1, output_component_id: 2, description: 'audio path' }],
    });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('fed by Signal In');
  });
});

describe('ModuleComponentsView naming and types', () => {
  const moduleResponse = valuesModule;

  it('summarizes the values a control can take in its row', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('0 … 10');
    expect(wrapper.find('[data-test="group-switch"]').text()).toContain('Cycle');
  });

  it('reclassifies a component as a mult jack with a group', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 4, type: 'bidirectional_jack', group_label: '1' });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="edit-component-4"]').trigger('click');
    await wrapper.find('[data-test="edit-type-4"]').setValue('bidirectional_jack');
    // The group field only appears for bidirectional jacks.
    await wrapper.find('[data-test="edit-group-4"]').setValue('1');
    await wrapper.find('[data-test="edit-save-4"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/4', {
      // The unchanged name and description ride along with the correction.
      name: 'Mode',
      description: '',
      type: 'bidirectional_jack',
      group_label: '1',
      // Jacks also carry the physical connector; '' keeps it an ordinary
      // 3.5mm patch point.
      port_kind: '',
    });
  });

  it('renames a component and edits its description', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 3, name: 'Rise Time', description: 'Attack slope' });
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The row shows text until it is put into edit mode.
    expect(wrapper.find('[data-test="edit-name-3"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-component-3"]').trigger('click');
    // The existing wording is what you start from.
    expect(wrapper.find('[data-test="edit-name-3"]').element.value).toBe('Rise');
    await wrapper.find('[data-test="edit-name-3"]').setValue('Rise Time');
    await wrapper.find('[data-test="edit-description-3"]').setValue('Attack slope');
    await wrapper.find('[data-test="edit-save-3"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/3', {
      name: 'Rise Time',
      description: 'Attack slope',
      type: 'knob',
      group_label: '',
      port_kind: '',
    });
  });

  it('will not save a component with a blank name', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="edit-component-3"]').trigger('click');
    await wrapper.find('[data-test="edit-name-3"]').setValue('   ');
    expect(wrapper.find('[data-test="edit-save-3"]').attributes('disabled')).toBeDefined();
  });
});

describe('ModuleComponentsView connectors', () => {
  it('shows connectors that are not 3.5mm patch points', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleComponentsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const inputs = wrapper.find('[data-test="group-input_jack"]').text();
    expect(inputs).toContain('midi din');
    expect(inputs).toContain('3.5mm');
  });
});
