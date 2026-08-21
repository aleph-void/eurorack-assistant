import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, path: '/modules/1/jacks/input' }),
  };
});

import { api } from '../../src/api.js';
import ModuleJacksView from '../../src/views/ModuleJacksView.vue';
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

const open = async (kind) => {
  api.get.mockResolvedValue(jackModule);
  const wrapper = mount(ModuleJacksView, { props: { id: '1', kind }, global: testGlobal() });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
});

// A jack is what a cable goes in, so where it sits on the picture is the fact
// the whole patch diagram is built out of: each kind is a page of its own,
// with the plate on it.
describe('ModuleJacksView', () => {
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
    expect(wrapper.find('[data-test="jacks"] h2').text()).toBe('Bidirectional jacks');
    expect(wrapper.find('[data-test="panel-jacks"]').text()).toContain('M1');
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

  it('says so rather than offering an arrange with nothing to arrange on', async () => {
    api.get.mockResolvedValue({ ...jackModule, panel: null });
    const wrapper = mount(ModuleJacksView, {
      props: { id: '1', kind: 'input' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="panel-jacks-no-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-1"]').attributes('disabled')).toBeDefined();
  });
});
