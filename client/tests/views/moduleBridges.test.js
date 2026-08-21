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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/bridges' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleBridgesView from '../../src/views/ModuleBridgesView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { conditionalModule, dualModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleBridgesView', () => {
  it('shows a declared dual and how its wires are paired', async () => {
    api.get.mockResolvedValue(dualModule);
    const wrapper = mount(ModuleBridgesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="bridge-91"]');
    expect(row.text()).toContain('a second copy of this module');
    expect(row.text()).toContain('paired by jack name');
    // The pair is already declared, so a second copy is no longer offered.
    const options = wrapper.findAll('[data-test="bridge-target"] option').map((o) => o.text());
    expect(options.some((t) => t.includes('A second copy'))).toBe(false);
  });

  it('declares a dual against a second copy of the same module', async () => {
    api.get.mockResolvedValue({ ...dualModule, bridges: [] });
    api.post.mockResolvedValue({ id: 92 });
    const wrapper = mount(ModuleBridgesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const options = wrapper.findAll('[data-test="bridge-target"] option').map((o) => o.text());
    expect(options.some((t) => t.includes('A second copy'))).toBe(true);
    await wrapper.find('[data-test="bridge-target"]').setValue('1');
    await wrapper.find('[data-test="bridges"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/bridges', { bridge_module_id: 1 });
  });

  it('unlinks a dual once the user confirms', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(dualModule);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleBridgesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-bridge-91"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/bridges/91');
  });

  it('offers no second copy of a module that is only racked once', async () => {
    api.get.mockResolvedValue({ ...conditionalModule, bridges: [] });
    const wrapper = mount(ModuleBridgesView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const options = wrapper.findAll('[data-test="bridge-target"] option').map((o) => o.text());
    expect(options.some((t) => t.includes('A second copy'))).toBe(false);
    expect(wrapper.find('[data-test="bridges"]').text()).toContain('not half of a dual');
  });
});
