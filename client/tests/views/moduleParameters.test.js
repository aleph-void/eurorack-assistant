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
    useRoute: () => ({ query: {}, path: '/modules/1/parameters' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleParametersView from '../../src/views/ModuleParametersView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';

// A menu-driven module: one encoder, two outputs, and everything they do
// living behind the screen.
const pamsModule = {
  id: 1,
  manufacturer: 'ALM',
  name: "Pamela's Pro Workout",
  manual_status: 'found',
  analysis_status: 'complete',
  summary: 'A clock and modulation source.',
  quantity: 1,
  racks: [{ id: 1, name: 'main rack', quantity: 1 }],
  manuals: [],
  components: [
    { id: 1, type: 'output_jack', name: 'OUT 1', values: [] },
    { id: 2, type: 'knob', name: 'Encoder', values: [] },
  ],
  parameters: [
    {
      id: 101,
      component_id: 1,
      name: 'Clock division',
      group_label: 'Output settings',
      value_type: 'enum',
      unit: null,
      value_min: null,
      value_max: null,
      default_value: 'x1',
      description: 'How fast OUT 1 runs against the clock.',
      options: [{ id: 1, value: '/4', description: 'Four times slower' }],
    },
    {
      id: 102,
      component_id: null,
      name: 'Tempo',
      group_label: null,
      value_type: 'number',
      unit: 'BPM',
      value_min: '10',
      value_max: '300',
      default_value: null,
      description: null,
      options: [],
    },
  ],
};

beforeEach(() => {
  refreshRackModules();
  vi.clearAllMocks();
});

describe('ModuleParametersView', () => {
  const open = async () => {
    api.get.mockResolvedValue(structuredClone(pamsModule));
    const wrapper = mount(ModuleParametersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    return wrapper;
  };

  it('groups the menu under the component each setting belongs to', async () => {
    const wrapper = await open();
    // The module-wide settings come first — they are the module's own state,
    // not any one jack's.
    const groups = wrapper.findAll('[data-test^="parameter-group-"]');
    expect(groups[0].text()).toContain('The module itself');
    expect(groups[0].text()).toContain('Tempo');
    expect(groups[1].text()).toContain('OUT 1');
    expect(wrapper.find('[data-test="parameter-101"]').text()).toContain('Clock division');
    expect(wrapper.find('[data-test="parameter-option-1"]').text()).toContain('Four times slower');
  });

  it('adds a parameter, gives it a setting to choose, and removes it', async () => {
    const wrapper = await open();
    api.post.mockResolvedValue({ id: 103 });

    await wrapper.find('[data-test="parameter-name"]').setValue('Wave');
    await wrapper.find('[data-test="parameter-component"]').setValue('1');
    await wrapper.find('[data-test="parameter-create-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      '/api/modules/1/parameters',
      expect.objectContaining({ name: 'Wave', component_id: 1, value_type: 'enum' })
    );

    await wrapper.find('[data-test="option-value-101"]').setValue('x2');
    await wrapper.find('[data-test="option-value-101"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/parameters/101/options', {
      value: 'x2',
      description: '',
    });

    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.delete.mockResolvedValue({ ok: true });
    await wrapper.find('[data-test="delete-parameter-101"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/parameters/101');
  });

  it('asks the app to read the menu out of the documents', async () => {
    const wrapper = await open();
    api.post.mockResolvedValue({ job_id: 5 });
    await wrapper.find('[data-test="find-parameters"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/parameters/find', {});
  });

  it('says so when a module keeps nothing in a menu', async () => {
    api.get.mockResolvedValue({ ...structuredClone(pamsModule), parameters: [] });
    const wrapper = mount(ModuleParametersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="parameters-empty"]').exists()).toBe(true);
  });
});
