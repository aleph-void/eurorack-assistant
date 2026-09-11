import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ push: routerPush, replace: vi.fn() }) };
});

import { api } from '../../src/api.js';
import PatchCompositionsView from '../../src/views/PatchCompositionsView.vue';
import { krellPatch } from '../patchFixtures.js';
import { compositionPage } from '../compositionFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (path) => {
    if (path === '/api/patches/7') return krellPatch;
    if (path === '/api/compositions?patch_id=7') {
      return {
        ...compositionPage,
        compositions: [
          { ...compositionPage.compositions[0], realization_id: 40, mapped_element_count: 1, notes: 'small case' },
        ],
      };
    }
    if (path === '/api/compositions?limit=500') {
      return {
        ...compositionPage,
        compositions: [...compositionPage.compositions, { id: 4, name: 'Drift', scene_count: 0, element_count: 0, patch_count: 0 }],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
});

describe('PatchCompositionsView', () => {
  it('lists the compositions performed on this patch and offers the rest', async () => {
    const wrapper = mount(PatchCompositionsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="performed-3"]');
    expect(row.text()).toContain('Tide');
    expect(row.text()).toContain('1 of 2 parts mapped');
    expect(row.text()).toContain('small case');
    const options = wrapper.findAll('[data-test="map-composition"] option').map((o) => o.text());
    expect(options).toContain('Drift');
    expect(options).not.toContain('Tide');
  });

  it('maps a composition onto this patch and opens the mapping', async () => {
    api.post.mockResolvedValue({ id: 41 });
    const wrapper = mount(PatchCompositionsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="map-composition"]').setValue('4');
    await wrapper.find('[data-test="map-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/compositions/4/patches', { patch_id: 7 });
    expect(routerPush).toHaveBeenCalledWith('/compositions/4/patches/7');
  });
});
