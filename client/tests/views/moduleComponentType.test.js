import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const route = { query: {}, path: '/modules/1/jacks/input' };
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => route,
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleComponentTypeView from '../../src/views/ModuleComponentTypeView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';

const panel = {
  source: 'image',
  url: '/api/panels/abc.png',
  width: 400,
  height: 1200,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
};

// A mult jack as well, so the third page has something of its own to show.
const jackModule = {
  ...mathsModule,
  panel,
  components: [
    ...mathsModule.components,
    { id: 4, type: 'bidirectional_jack', name: 'M1', group_label: '1' },
  ],
};

// A module whose mult jacks are the point: a 2x2 mult the analysis left
// ungrouped, plus a switch's jacks, which are bidirectional but not copies.
const multModule = {
  ...mathsModule,
  panel,
  components: [
    ...mathsModule.components,
    { id: 4, type: 'bidirectional_jack', name: 'M1 A', group_label: null },
    { id: 5, type: 'bidirectional_jack', name: 'M1 B', group_label: null },
    { id: 6, type: 'bidirectional_jack', name: 'M2 A', group_label: null },
    { id: 7, type: 'bidirectional_jack', name: 'M2 B', group_label: null },
    { id: 8, type: 'bidirectional_jack', name: 'SW COM', group_label: null },
    { id: 9, type: 'bidirectional_jack', name: 'SW 1', group_label: null },
  ],
  switches: [
    { id: 3, name: 'Router', common_component_id: 8, step_component_ids: [9] },
  ],
};

// A Doepfer A-182-1: two jacks, each with its own three-position toggle
// deciding which internal bus it sits on. No label on the jack could say
// that, so the section is recorded a position at a time.
const switchedMultModule = {
  ...mathsModule,
  panel,
  components: [
    ...mathsModule.components,
    { id: 4, type: 'bidirectional_jack', name: 'OUT 1', group_label: null },
    { id: 5, type: 'bidirectional_jack', name: 'OUT 2', group_label: null },
    {
      id: 6,
      type: 'switch',
      name: 'SW 1',
      values: [
        { id: 20, type: 'enum', value: 'bus 1' },
        { id: 21, type: 'enum', value: 'bus 2' },
        { id: 22, type: 'enum', value: 'off' },
      ],
    },
  ],
  switches: [],
  mult_groups: [
    { id: 30, component_id: 4, group_label: '1', condition_component_id: 6, condition_value: 'bus 1' },
    { id: 31, component_id: 4, group_label: '2', condition_component_id: 6, condition_value: 'bus 2' },
  ],
};

const openWith = async (record, type) => {
  api.get.mockResolvedValue(record);
  const wrapper = mount(ModuleComponentTypeView, { props: { id: '1', type }, global: testGlobal() });
  await flushPromises();
  return wrapper;
};

const openType = async (type) => {
  api.get.mockResolvedValue(jackModule);
  const wrapper = mount(ModuleComponentTypeView, { props: { id: '1', type }, global: testGlobal() });
  await flushPromises();
  return wrapper;
};

const open = async (kind) => {
  api.get.mockResolvedValue(jackModule);
  const wrapper = mount(ModuleComponentTypeView, {
    props: { id: '1', type: `${kind}_jack` },
    global: testGlobal(),
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  route.query = {};
});

// A jack is what a cable goes in, so where it sits on the picture is the fact
// the whole patch diagram is built out of: each kind is a page of its own,
// with the plate on it.
describe('ModuleComponentTypeView', () => {
  it('lists only the inputs on the input page, beside the front plate', async () => {
    const wrapper = await open('input');
    expect(wrapper.find('[data-test="jacks"] h2').text()).toBe('Input jacks');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).toContain('Signal In');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).not.toContain('EOR');
    expect(wrapper.find('[data-test="module-panel-svg"]').exists()).toBe(true);
  });

  it('lists only the outputs on the output page', async () => {
    const wrapper = await open('output');
    expect(wrapper.find('[data-test="jacks"] h2').text()).toBe('Output jacks');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).toContain('EOR');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).not.toContain('Signal In');
  });

  it('lists only the bidirectional jacks on theirs', async () => {
    const wrapper = await open('bidirectional');
    expect(wrapper.find('[data-test="jacks"] h2').text()).toBe('Bidirectional jacks (mults)');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).toContain('M1');
  });

  // Getting from one kind's page to another is a press on the chip row, not
  // a trip through the drawer — which lists only the jacks.
  it('offers every kind the module has as a chip, the current one lit', async () => {
    const wrapper = await open('input');
    expect(wrapper.find('[data-test="type-nav-all"]').attributes('to')).toBe(
      '/modules/1/components'
    );
    const input = wrapper.find('[data-test="type-nav-input_jack"]');
    expect(input.attributes('aria-current')).toBe('page');
    expect(input.text()).toContain('1');
    expect(wrapper.find('[data-test="type-nav-knob"]').attributes('to')).toBe(
      '/modules/1/parts/knob'
    );
    expect(wrapper.find('[data-test="type-nav-bidirectional_jack"]').attributes('to')).toBe(
      '/modules/1/jacks/bidirectional'
    );
    // A kind the module has none of gets no chip…
    expect(wrapper.find('[data-test="type-nav-slider"]').exists()).toBe(false);

    // …except the kind of the page being read, or nothing would say where
    // you are.
    const displays = await openType('display');
    const chip = displays.find('[data-test="type-nav-display"]');
    expect(chip.attributes('aria-current')).toBe('page');
    expect(chip.text()).toContain('0');
  });

  it('carries the rack the reader is walking on every chip', async () => {
    route.query = { rack: '2' };
    const wrapper = await open('input');
    expect(wrapper.find('[data-test="type-nav-all"]').attributes('to')).toBe(
      '/modules/1/components?rack=2'
    );
    expect(wrapper.find('[data-test="type-nav-knob"]').attributes('to')).toBe(
      '/modules/1/parts/knob?rack=2'
    );
  });

  // The point of the page: the picture and the thing to drag onto it are one
  // screen, and every row is a toggle.
  it('marks a jack as being arranged, and puts the panel back afterwards', async () => {
    const wrapper = await open('input');
    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="arrange-component-1"]').text()).toBe('Arranging');
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Signal In');

    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="arrange-component-1"]').text()).toBe('Arrange');
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').exists()).toBe(false);
  });

  // A jack the analysis never placed has no marker to take hold of, so
  // arranging it starts by giving it one.
  it('gives a jack the picture never placed a marker before arranging it', async () => {
    api.post.mockResolvedValue({
      panel: {
        ...panel,
        components: [
          ...panel.components,
          { id: 6, component_id: 4, name: 'M1', shape: 'jack', x: 0.5, y: 0.5 },
        ],
      },
    });
    const wrapper = await open('bidirectional');
    expect(wrapper.find('[data-test="panel-jack-unplaced-4"]').exists()).toBe(true);

    await wrapper.find('[data-test="arrange-component-4"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/components', { component_id: 4 });
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('M1');
  });

  // Every component type is a page, not only the three kinds of jack: the
  // knobs are as much a thing to look at as the inputs, and their markers are
  // as likely to be in the wrong place.
  it('gives the controls pages of their own, over the same view', async () => {
    const knobs = await openType('knob');
    expect(knobs.find('[data-test="jacks"] h2').text()).toBe('Knobs');
    expect(knobs.find('[data-test="panel-jacks"]').text()).toContain('Rise');
    expect(knobs.find('[data-test="panel-jacks"]').text()).not.toContain('Signal In');

    const displays = await openType('display');
    expect(displays.find('[data-test="jacks"] h2').text()).toBe('Displays');
    expect(displays.find('[data-test="panel-jacks-empty"]').exists()).toBe(true);
  });

  // A mult section IS its group label: a 2x2 mult left ungrouped is ONE
  // section, so a cable into any of its four jacks copies to the other three.
  // Setting that right is what this page is for.
  it('sets the mult sections from the bidirectional page, in one save', async () => {
    const wrapper = await openWith(multModule, 'bidirectional_jack');
    expect(wrapper.find('[data-test="mult-section-ungrouped"]').text()).toContain('M1 A, M1 B');

    await wrapper.find('[data-test="mult-group-input-4"]').setValue('1');
    await wrapper.find('[data-test="mult-group-input-5"]').setValue('1');
    await wrapper.find('[data-test="mult-group-input-6"]').setValue('2');
    await wrapper.find('[data-test="mult-group-input-7"]').setValue('2');

    // The sections say what the labels would make before anything is written.
    expect(wrapper.find('[data-test="mult-section-1"]').text()).toContain('M1 A, M1 B');
    expect(wrapper.find('[data-test="mult-section-2"]').text()).toContain('M2 A, M2 B');
    expect(wrapper.find('[data-test="mult-groups-changed"]').text()).toContain('4 unsaved');

    await wrapper.find('[data-test="mult-groups-save"]').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledTimes(4);
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/4', { group_label: '1' });
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/7', { group_label: '2' });
  });

  // A routing switch selects one step at a time; its jacks are bidirectional
  // but they are not a mult, and neither the tracer nor the cable rules read
  // a group off them.
  it('leaves a switch section\'s jacks out of the mult sections, and says why', async () => {
    const wrapper = await openWith(multModule, 'bidirectional_jack');
    expect(wrapper.find('[data-test="mult-group-switch-8"]').text()).toContain('Router');
    expect(wrapper.find('[data-test="mult-sections"]').text()).not.toContain('SW COM');
  });

  // A switch module's jacks are bidirectional and are NOT a mult, so the page
  // they land on has to show the grouping they DO have and where it is built.
  it('shows the module\'s switch sections beside the mult ones', async () => {
    const wrapper = await openWith(multModule, 'bidirectional_jack');
    const switches = wrapper.find('[data-test="switch-section-3"]');
    expect(switches.text()).toContain('Router');
    expect(switches.text()).toContain('SW COM');
    expect(switches.text()).toContain('SW 1');
    expect(wrapper.find('[data-test="mult-groups"]').text()).toContain('Switches');
  });

  // Nothing recorded is the case a switch module actually arrives in: the
  // page has to say that a router is a section rather than a group.
  it('says a router is a switch section rather than a group when none is recorded', async () => {
    const wrapper = await openWith({ ...multModule, switches: [] }, 'bidirectional_jack');
    expect(wrapper.find('[data-test="switch-sections-empty"]').text()).toContain('SELECTS');
    // With no section recorded, every jack is grouped as a mult again.
    expect(wrapper.find('[data-test="mult-sections"]').text()).toContain('SW COM');
  });

  // The switched half: a jack whose bus is decided by a toggle takes a row
  // per position, and the label it would otherwise carry is not read at all.
  it('records a switched jack one toggle position at a time', async () => {
    api.post.mockResolvedValue({ id: 32 });
    const wrapper = await openWith(switchedMultModule, 'bidirectional_jack');

    // What is recorded reads as the panel does, and the plain label is off.
    expect(wrapper.find('[data-test="mult-switched-4"]').text()).toContain('SW 1 = bus 1 → 1');
    expect(wrapper.find('[data-test="mult-switched-4"]').text()).toContain('SW 1 = bus 2 → 2');
    expect(wrapper.find('[data-test="mult-group-input-4"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="mult-group-input-5"]').attributes('disabled')).toBeUndefined();

    // Both buses OUT 1 could be on are shown, each with the position that
    // would put it there.
    expect(wrapper.find('[data-test="mult-section-1"]').text()).toContain('OUT 1 (with SW 1 = bus 1)');
    expect(wrapper.find('[data-test="mult-section-2"]').text()).toContain('OUT 1 (with SW 1 = bus 2)');
    // OUT 2 has no rows, so it is where its (empty) label puts it.
    expect(wrapper.find('[data-test="mult-section-ungrouped"]').text()).toContain('OUT 2');

    await wrapper.find('[data-test="mult-position-add-5"]').trigger('click');
    await wrapper.find('[data-test="mult-position-control-5"]').setValue('6');
    await wrapper.find('[data-test="mult-position-value-5"]').setValue('bus 2');
    await wrapper.find('[data-test="mult-position-label-5"]').setValue('2');
    await wrapper.find('[data-test="mult-position-form-5"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/mult-groups', {
      component_id: 5,
      condition_component_id: 6,
      condition_value: 'bus 2',
      group_label: '2',
    });
  });

  it('takes a switched position away again', async () => {
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = await openWith(switchedMultModule, 'bidirectional_jack');
    await wrapper.find('[data-test="mult-position-remove-30"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/mult-groups/30');
    confirm.mockRestore();
  });

  it('offers the groups on the bidirectional page only', async () => {
    const knobs = await openWith(multModule, 'knob');
    expect(knobs.find('[data-test="mult-groups"]').exists()).toBe(false);
    const mults = await openWith(multModule, 'bidirectional_jack');
    expect(mults.find('[data-test="mult-groups"]').exists()).toBe(true);
  });

  it('keeps what was typed when a save fails part-way through', async () => {
    api.put.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('nope'));
    const wrapper = await openWith(multModule, 'bidirectional_jack');
    await wrapper.find('[data-test="mult-group-input-4"]').setValue('1');
    await wrapper.find('[data-test="mult-group-input-5"]').setValue('1');
    await wrapper.find('[data-test="mult-groups-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="mult-groups-error"]').text()).toContain('1 of 2 saved');
    expect(wrapper.find('[data-test="mult-group-input-5"]').element.value).toBe('1');
  });

  it('says so rather than offering an arrange with nothing to arrange on', async () => {
    api.get.mockResolvedValue({ ...jackModule, panel: null });
    const wrapper = mount(ModuleComponentTypeView, {
      props: { id: '1', type: 'input_jack' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="panel-jacks-no-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-1"]').attributes('disabled')).toBeDefined();
  });
});
