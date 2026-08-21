import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7/modules' }),
  };
});

import { api } from '../../src/api.js';
import PatchModulesView from '../../src/views/PatchModulesView.vue';
import { krellPatch, richPatch, systemPatch as systemPatchFixture } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchModulesView', () => {
  const systemPatch = systemPatchFixture;

  it('labels each instance by its role and says which are no longer racked', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchModulesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('LXR (snare voice)');
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('Rhythm');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('off-rack gear');
  });

  it('marks a module deleted since the snapshot as gone', async () => {
    api.get.mockResolvedValue(krellPatch);
    const wrapper = mount(PatchModulesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain(
      'no longer in your system'
    );
  });

  it('says the patch spans a system, and names each module’s rack', async () => {
    api.get.mockResolvedValue(systemPatch);
    const wrapper = mount(PatchModulesView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The snapshot table gains a rack column only when there is more than one.
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('left case');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('right case');
  });

  it('leaves a single-rack patch as it was', async () => {
    // The same payload with one rack behind it: no system, one rack name.
    api.get.mockResolvedValue({
      ...systemPatch,
      rack_id: 10,
      rack_name: 'left case',
      system_id: null,
      system_name: null,
      modules: systemPatch.modules.map((pm) => ({ ...pm, rack_id: 10, rack_name: 'left case' })),
    });
    const wrapper = mount(PatchModulesView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    // No rack column: every instance stands in the same one.
    expect(wrapper.find('[data-test="patch-module-11"]').findAll('td')).toHaveLength(3);
  });
});
