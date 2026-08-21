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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/switches' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleSwitchesView from '../../src/views/ModuleSwitchesView.vue';
import { mathsModule } from '../moduleFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleSwitchesView', () => {
  const moduleResponse = mathsModule;

  it('records and removes routing switch sections', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    // A switch section needs a common plus two steps, so this module gets a
    // second input jack on top of the shared fixture.
    api.get.mockResolvedValue({
      ...moduleResponse,
      components: [
        ...moduleResponse.components,
        { id: 4, type: 'input_jack', name: 'Signal In 2', description: null, voltage_min: null, voltage_max: null, polarity: null },
      ],
      switches: [
        { id: 4, name: 'Section 1', common_component_id: 2, step_component_ids: [1, 4], description: null },
      ],
    });
    api.post.mockResolvedValue({ id: 5 });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleSwitchesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="switch-4"]');
    expect(row.text()).toContain('Section 1');
    expect(row.text()).toContain('EOR');
    expect(row.text()).toContain('Signal In');

    // A section needs a common plus at least two distinct steps: selecting
    // only the common's own jack leaves too few.
    await wrapper.find('[data-test="switch-common"]').setValue('2');
    const steps = wrapper.find('[data-test="switch-steps"]');
    const stepOptions = steps.findAll('option');
    await stepOptions[1].setSelected(); // EOR — the common itself, filtered out
    expect(wrapper.find('[data-test="switch-create"]').attributes('disabled')).toBeDefined();
    await stepOptions[0].setSelected(); // Signal In
    await stepOptions[2].setSelected(); // Signal In 2
    await wrapper.find('[data-test="switch-name"]').setValue('Section 2');
    await wrapper.find('[data-test="switches"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/switches', {
      common_component_id: 2,
      step_component_ids: [1, 4],
      name: 'Section 2',
    });

    await wrapper.find('[data-test="delete-switch-4"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/switches/4');
  });
});
