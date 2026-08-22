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

  it('links an expander chosen from the other modules in your racks', async () => {
    // The candidate list is every OTHER module the user has that is not
    // already linked to this one.
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/modules'
          ? [
              { id: 1, manufacturer: 'Intellijel', name: 'Atlantix' },
              { id: 2, manufacturer: 'Intellijel', name: 'Atlx' },
              { id: 88, manufacturer: 'Make Noise', name: 'Maths' },
            ]
          : conditionalModule
      )
    );
    api.post.mockResolvedValue({ id: 90 });
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const select = wrapper.find('[data-test="expander-target"]');
    const offered = select.findAll('option').map((o) => o.text().trim());
    // Itself is not offered, and neither is the panel already linked.
    expect(offered).toEqual(['Select a module…', 'Make Noise Maths']);
    // Nothing chosen yet: nothing to link.
    expect(wrapper.find('[data-test="expander-create"]').attributes('disabled')).toBeDefined();

    await select.setValue('88');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/expanders', { expander_module_id: 88 });
    // The record is re-read, and the picker put back to nothing chosen.
    expect(select.element.value).toBe('');
  });

  it('says why a link was refused, where the link was being made', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/modules'
          ? [{ id: 88, manufacturer: 'Make Noise', name: 'Maths' }]
          : conditionalModule
      )
    );
    api.post.mockRejectedValue(new Error('that module already hosts this one'));
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="expander-target"]').setValue('88');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="expander-error"]').text()).toContain(
      'that module already hosts this one'
    );
  });

  it('keeps the expander when the unlink is called off', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleExpandersView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-expander-71"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="expander-71"]').exists()).toBe(true);
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
