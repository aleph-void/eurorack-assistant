import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
const routerReplace = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
    useRoute: () => ({ query: {}, path: '/patches/7/scope' }),
  };
});

import { api } from '../../src/api.js';
import PatchScopeView from '../../src/views/PatchScopeView.vue';
import ScopePanel from '../../src/components/ScopePanel.vue';
import { krellPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PatchScopeView', () => {
  it('hands the scope the instances of this patch and says where captures land', async () => {
    api.get.mockImplementation(async (path) =>
      path === '/api/patches/7' ? krellPatch : []
    );
    const wrapper = mount(PatchScopeView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    expect(wrapper.find('h1').text()).toContain('Krell');
    const panel = wrapper.findComponent(ScopePanel);
    expect(panel.props('modules').map((pm) => pm.id)).toEqual(krellPatch.modules.map((pm) => pm.id));
    // The notes are a page of their own now, so the scope says where a
    // capture is filed rather than showing it here.
    expect(wrapper.find('[data-test="captures-note"]').text()).toContain('Notes on this patch');
  });
});
