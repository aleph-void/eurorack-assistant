import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

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
    useRoute: () => ({ query: {}, path: '/patches/7/questions' }),
  };
});

import { api } from '../../src/api.js';
import PatchQuestionsView from '../../src/views/PatchQuestionsView.vue';
import { krellPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PatchQuestionsView', () => {
  it('lists the questions asked about this patch and attaches the patch to a new one', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/patches/7'
          ? krellPatch
          : [
              {
                id: 2,
                prompt: 'Why does it drop out?',
                status: 'scoped',
                created_at: '2026-08-12T10:00:00Z',
              },
            ]
      )
    );
    api.post.mockResolvedValue({ id: 5 });
    const wrapper = mount(PatchQuestionsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('Krell');
    expect(api.get).toHaveBeenCalledWith('/api/questions?patch_id=7');
    expect(wrapper.find('[data-test="record-question-table"]').text()).toContain(
      'Why does it drop out?'
    );

    await wrapper.find('[data-test="ask-prompt"]').setValue('Why is the bass dropping out?');
    await wrapper.find('[data-test="record-questions"] form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'Why is the bass dropping out?',
      patch_ids: [7],
    });
    expect(routerPush).toHaveBeenCalledWith({ name: 'question-detail', params: { id: 5 } });
  });
});
