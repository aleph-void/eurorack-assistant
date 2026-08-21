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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/expanders' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleExpandersView from '../../src/views/ModuleExpandersView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { conditionalModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleExpandersView', () => {
  it('lists the panels linked to this module', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="expander-71"]').text()).toContain('Atlx');
    expect(wrapper.find('[data-test="expander-71"]').text()).toContain('expands this module');
  });

  it('unlinks an expander panel', async () => {
    // The removal goes through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-expander-71"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/expanders/71');
  });

  it('points out a panel the manual named that is not linked yet', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const suggestion = wrapper.find('[data-test="expander-suggestion-0"]');
    expect(suggestion.text()).toContain('Performer');
    expect(suggestion.text()).toContain('not in any of your racks');
  });
});
