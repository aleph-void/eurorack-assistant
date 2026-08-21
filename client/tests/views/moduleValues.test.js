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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/values' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleValuesView from '../../src/views/ModuleValuesView.vue';
import { valuesModule } from '../moduleFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleValuesView', () => {
  const moduleResponse = valuesModule;

  it('lists the values the analysis wrote, naming the control each belongs to', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleValuesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="value-3"]');
    expect(row.text()).toContain('Mode');
    expect(row.text()).toContain('loops');
  });

  it('adds and removes a value', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ id: 9 });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleValuesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="value-component"]').setValue('4');
    await wrapper.find('[data-test="value-type"]').setValue('enum');
    await wrapper.find('[data-test="value-value"]').setValue('Sustain');
    await wrapper.find('[data-test="value-description"]').setValue('holds');
    await wrapper.find('[data-test="values"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/components/4/values', {
      type: 'enum',
      value: 'Sustain',
      description: 'holds',
    });

    await wrapper.find('[data-test="delete-value-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/components/3/values/1');
  });

  it('edits the label and description of a value the analysis wrote', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 3, value: 'Cycle', description: 'repeats the envelope' });
    const wrapper = mount(ModuleValuesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The row shows text until it is put into edit mode.
    expect(wrapper.find('[data-test="edit-value-description-3"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-value-3"]').trigger('click');
    // The existing wording is what you start from.
    expect(wrapper.find('[data-test="edit-value-description-3"]').element.value).toBe('loops');
    await wrapper
      .find('[data-test="edit-value-description-3"]')
      .setValue('repeats the envelope');
    await wrapper.find('[data-test="save-value-3"]').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/4/values/3', {
      value: 'Cycle',
      description: 'repeats the envelope',
    });
    // Saving closes the editor and the reloaded row takes over.
    expect(wrapper.find('[data-test="edit-value-description-3"]').exists()).toBe(false);
  });
});
