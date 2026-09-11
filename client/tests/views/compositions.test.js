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
import { dialog } from '../../src/dialog.js';
import CompositionsView from '../../src/views/CompositionsView.vue';
import { compositionPage } from '../compositionFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CompositionsView', () => {
  it('lists compositions with how much of each is written and mapped', async () => {
    api.get.mockResolvedValue(compositionPage);
    const wrapper = mount(CompositionsView, { global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/compositions?limit=100');
    const row = wrapper.find('[data-test="composition-3"]');
    expect(row.text()).toContain('Tide');
    expect(row.text()).toContain('92 BPM');
    expect(row.findAll('td').map((td) => td.text())).toEqual(
      expect.arrayContaining(['2', '2', '1'])
    );
  });

  it('creates a composition and opens its storyboard', async () => {
    api.get.mockResolvedValue({ ...compositionPage, compositions: [], total: 0 });
    api.post.mockResolvedValue({ id: 9, name: 'Drift' });
    const wrapper = mount(CompositionsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="no-compositions"]').exists()).toBe(true);

    await wrapper.find('[data-test="new-name"]').setValue('Drift');
    await wrapper.find('[data-test="new-tempo"]').setValue('120');
    await wrapper.find('[data-test="create-form"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/compositions', {
      name: 'Drift',
      description: undefined,
      tempo_bpm: 120,
    });
    expect(routerPush).toHaveBeenCalledWith('/compositions/9');
  });

  it('deletes a composition once confirmed', async () => {
    api.get.mockResolvedValue(compositionPage);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(CompositionsView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-3"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/compositions/3');
    expect(wrapper.find('[data-test="composition-3"]').exists()).toBe(false);
  });
});
