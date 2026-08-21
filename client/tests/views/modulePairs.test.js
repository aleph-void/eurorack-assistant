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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/pairs' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModulePairsView from '../../src/views/ModulePairsView.vue';
import { conditionalModule } from '../moduleFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModulePairsView', () => {
  it('lists the jacks that carry the two halves of one signal', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModulePairsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="pair-61"]').text()).toContain('stereo');
  });

  it('adds a stereo pair', async () => {
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 62 });
    const wrapper = mount(ModulePairsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="pair-a"]').setValue('3');
    await wrapper.find('[data-test="pair-b"]').setValue('4');
    await wrapper.find('[data-test="pairs"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/pairs', {
      a_component_id: 3,
      b_component_id: 4,
      kind: 'stereo',
    });
  });

  it('removes a stereo pair once the user confirms', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModulePairsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove jack pair', danger: true })
    );
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/pairs/61');
    // The module is reloaded so the pair list reflects the server.
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1')).toHaveLength(2);
  });

  it('keeps the pair when the confirm is declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModulePairsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1')).toHaveLength(1);
  });

  it('shows why a pair could not be removed', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.delete.mockRejectedValue(new Error('pair is gone already'));
    const wrapper = mount(ModulePairsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="pair-error"]').text()).toContain('gone already');
  });
});
