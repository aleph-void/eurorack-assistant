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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/routes' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleRoutesView from '../../src/views/ModuleRoutesView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule, conditionalModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleRoutesView', () => {
  const moduleResponse = mathsModule;

  it('records an internal signal path', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, routes: [] });
    api.post.mockResolvedValue({ id: 7 });
    const wrapper = mount(ModuleRoutesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="route-input"]').setValue('1');
    await wrapper.find('[data-test="route-output"]').setValue('2');
    await wrapper.find('[data-test="routes"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/routes', {
      input_component_id: 1,
      output_component_id: 2,
    });
  });

  it('lists routes and removes them', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue({
      ...moduleResponse,
      routes: [{ id: 7, input_component_id: 1, output_component_id: 2, description: 'audio path' }],
    });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleRoutesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="route-7"]');
    expect(row.text()).toContain('Signal In');
    expect(row.text()).toContain('EOR');
    expect(row.text()).toContain('audio path');

    await wrapper.find('[data-test="delete-route-7"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/routes/7');
  });
});

describe('ModuleRoutesView conditional paths', () => {
  it('shows the control position a path depends on', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleRoutesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="route-condition-51"]').text()).toContain('PWM SOURCE = right');
  });

  it('offers the expander’s jacks as the end of a path', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleRoutesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    // A route may end at a jack on the linked panel.
    const outputs = wrapper.findAll('[data-test="route-output"] option').map((o) => o.text());
    expect(outputs.some((t) => t.includes('LP — Intellijel Atlx'))).toBe(true);
  });
});
