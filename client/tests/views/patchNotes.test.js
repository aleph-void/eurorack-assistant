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
    useRoute: () => ({ query: {}, path: '/patches/7/notes' }),
  };
});

import { api } from '../../src/api.js';
import PatchNotesView from '../../src/views/PatchNotesView.vue';
import { krellPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PatchNotesView', () => {
  it('lists what has been written down about the patch, under the patch header', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/patches/7'
          ? krellPatch
          : [{ id: 3, title: null, body: 'let it ring out', created_at: '2026-08-12T10:00:00Z' }]
      )
    );
    const wrapper = mount(PatchNotesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('Krell');
    expect(wrapper.text()).toContain('let it ring out');
  });
});
