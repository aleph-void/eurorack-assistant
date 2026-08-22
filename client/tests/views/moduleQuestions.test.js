import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => ({ query: {}, path: '/modules/1/questions' }),
  };
});

import { api } from '../../src/api.js';
import ModuleQuestionsView from '../../src/views/ModuleQuestionsView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';

beforeEach(() => {
  refreshRackModules();
  vi.clearAllMocks();
});

describe('ModuleQuestionsView', () => {
  it('lists the questions asked about this module and asks another with it in scope', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path.startsWith('/api/questions')
          ? [
              {
                id: 4,
                prompt: 'How do I get a slow rise?',
                status: 'answered',
                created_at: '2026-08-12T10:00:00Z',
              },
            ]
          : mathsModule
      )
    );
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(ModuleQuestionsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The list is the module's own questions, not every question asked.
    expect(api.get).toHaveBeenCalledWith('/api/questions?module_id=1');
    expect(wrapper.find('[data-test="record-question-table"]').text()).toContain(
      'How do I get a slow rise?'
    );

    await wrapper.find('[data-test="ask-prompt"]').setValue('Why is this so quiet?');
    await wrapper.find('[data-test="record-questions"] form').trigger('submit');
    await flushPromises();

    // The module goes into the question's scope as it is created — the
    // wording never names it.
    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'Why is this so quiet?',
      module_ids: [1],
    });
    expect(routerPush).toHaveBeenCalledWith({ name: 'question-detail', params: { id: 9 } });
  });

  it('says so when nothing has been asked about the module yet', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/questions') ? [] : mathsModule)
    );
    const wrapper = mount(ModuleQuestionsView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="no-questions"]').text()).toContain('No questions');
    // Nothing to ask yet, so the button is not offered as though there were.
    expect(wrapper.find('[data-test="ask-submit"]').attributes('disabled')).toBeDefined();
  });
});
