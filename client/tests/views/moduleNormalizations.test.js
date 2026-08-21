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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/normalizations' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleNormalizationsView from '../../src/views/ModuleNormalizationsView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule, conditionalModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleNormalizationsView', () => {
  const moduleResponse = mathsModule;

  it('shows normalled connections with resolved component names', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      normalizations: [
        {
          id: 1,
          target_component_id: 1,
          source_component_id: 2,
          source_label: null,
          kind: 'output',
          description: 'EOR feeds the input by default.',
        },
        {
          id: 2,
          target_component_id: 1,
          source_component_id: null,
          source_label: 'internal oscillator',
          kind: 'internal',
          description: null,
        },
      ],
    });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const first = wrapper.find('[data-test="normalization-1"]');
    expect(first.text()).toContain('Signal In');
    expect(first.text()).toContain('EOR');
    expect(first.text()).toContain('from output');
    expect(first.text()).toContain('EOR feeds the input by default.');
    const second = wrapper.find('[data-test="normalization-2"]');
    expect(second.text()).toContain('internal oscillator');
    expect(second.text()).toContain('internal signal');
  });

  it('still offers the add form when no normalizations are recorded', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, normalizations: [] });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const panel = wrapper.find('[data-test="normalizations"]');
    expect(panel.text()).toContain('No normalled connections recorded');
    expect(panel.find('table').exists()).toBe(false);
    expect(panel.find('[data-test="norm-create"]').exists()).toBe(true);
  });

  it('manually adds a normalization from a jack and from an internal signal', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, normalizations: [] });
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // Targets are the module's input jacks; sources are all jacks plus the
    // internal option. The button stays disabled until the form is complete.
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('2');
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-test="norm-description"]').setValue('EOR feeds the input');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_component_id: 2,
      description: 'EOR feeds the input',
    });

    // Choosing the internal option reveals a label field and posts the label.
    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('internal');
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="norm-source-label"]').setValue('internal oscillator');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_label: 'internal oscillator',
    });
  });

  it('deletes a normalization', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue({
      ...moduleResponse,
      normalizations: [
        {
          id: 7,
          target_component_id: 1,
          source_component_id: 2,
          source_label: null,
          kind: 'output',
          description: null,
        },
      ],
    });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-normalization-7"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/normalizations/7');
  });
});

describe('ModuleNormalizationsView conditional defaults', () => {
  it('shows the control position a default depends on, and what breaks it', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const condition = wrapper.find('[data-test="normalization-condition-41"]');
    expect(condition.text()).toContain('PWM SOURCE = left');
    expect(condition.text()).toContain('pwm source');
    // The output-to-output default names the cable that cancels it.
    expect(wrapper.find('[data-test="normalization-42"]').text()).toContain('a cable out of L');
    // A default with no condition reads as unconditional.
    expect(wrapper.find('[data-test="normalization-42"]').text()).toContain('always');
  });

  it('records a default that only exists in one switch position', async () => {
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 43 });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('2');
    await wrapper.find('[data-test="norm-condition"]').setValue('5');
    // The switch's recorded positions become the choices.
    const values = wrapper.findAll('[data-test="norm-condition-value"] option').map((o) => o.text());
    expect(values).toContain('right');
    await wrapper.find('[data-test="norm-condition-value"]').setValue('right');
    await wrapper.find('[data-test="norm-alt-group"]').setValue('pwm source');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_component_id: 2,
      condition_component_id: 5,
      condition_value: 'right',
      alt_group: 'pwm source',
    });
  });

  it('records the jack whose outgoing cable breaks a default', async () => {
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 44 });
    const wrapper = mount(ModuleNormalizationsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="norm-target"]').setValue('4');
    await wrapper.find('[data-test="norm-source"]').setValue('3');
    await wrapper.find('[data-test="norm-break"]').setValue('3');
    await wrapper.find('[data-test="norm-break-on"]').setValue('cable_out');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 4,
      source_component_id: 3,
      break_component_id: 3,
      break_on: 'cable_out',
    });
  });
});
