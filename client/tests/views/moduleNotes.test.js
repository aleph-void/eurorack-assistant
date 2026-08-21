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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/notes' }),
  };
});

import { api } from '../../src/api.js';
import ModuleNotesView from '../../src/views/ModuleNotesView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleNotesView', () => {
  const moduleResponse = mathsModule;

  it('shows module and component notes and creates a component-level note', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      notes: [
        { id: 1, title: null, body: 'module-level', component_id: null },
        { id: 2, title: 'Jack', body: 'about EOR', component_id: 2 },
      ],
    });
    api.post.mockResolvedValue({ id: 3 });
    const wrapper = mount(ModuleNotesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const notes = wrapper.find('[data-test="notes"]');
    expect(notes.text()).toContain('module-level');
    expect(notes.text()).toContain('about EOR');
    // The component note is labeled with the component's name.
    expect(wrapper.find('[data-test="note-2-2"]').text()).toContain('EOR');

    await wrapper.find('[data-test="note-target"]').setValue('2');
    await wrapper.find('[data-test="note-body"]').setValue('watch the gate level');
    await wrapper.find('[data-test="notes"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes', {
      body: 'watch the gate level',
      component_ids: [2],
    });
  });

  it('detaches a note from the module', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      notes: [{ id: 1, title: null, body: 'module-level', component_id: null }],
    });
    api.post.mockResolvedValue({});
    const wrapper = mount(ModuleNotesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="detach-note-1-module"]').trigger('click');
    expect(api.post).toHaveBeenCalledWith('/api/notes/1/detach', { module_id: 1 });
  });
});
