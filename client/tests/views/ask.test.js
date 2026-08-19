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
    useRoute: () => ({ query: currentRouteQuery }),
  };
});

import { api } from '../../src/api.js';
import AskView from '../../src/views/AskView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('AskView', () => {
  it('submits a question and navigates to its detail page', async () => {
    api.post.mockResolvedValue({ id: 12, status: 'pending' });
    const wrapper = mount(AskView, { global: testGlobal() });
    await wrapper.find('[data-test="prompt"]').setValue('How do I patch a krell?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', { prompt: 'How do I patch a krell?' });
    expect(routerPush).toHaveBeenCalledWith({ name: 'question-detail', params: { id: 12 } });
  });

  it('disables submit with an empty prompt', () => {
    const wrapper = mount(AskView, { global: testGlobal() });
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeDefined();
  });

  it('asks about the patch named in the URL', async () => {
    currentRouteQuery = { patch: '3' };
    api.get.mockResolvedValue([
      { id: 3, name: 'Krell', rack_name: 'main rack' },
      { id: 4, name: 'Drone', rack_name: 'main rack' },
    ]);
    api.post.mockResolvedValue({ id: 12 });
    const wrapper = mount(AskView, { global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="ask-patch"]').element.value).toBe('Krell');
    await wrapper.find('[data-test="prompt"]').setValue('Why is there no sound?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'Why is there no sound?',
      patch_id: 3,
    });
  });

  it('finds a patch by typing its name', async () => {
    api.get.mockResolvedValue([
      { id: 3, name: 'Krell', rack_name: 'main rack' },
      { id: 4, name: 'Drone', rack_name: 'main rack' },
    ]);
    api.post.mockResolvedValue({ id: 12 });
    const wrapper = mount(AskView, { global: testGlobal() });
    await flushPromises();

    const box = wrapper.find('[data-test="ask-patch"]');
    await box.trigger('focus');
    await box.setValue('dro');
    const options = wrapper.findAll('[data-test^="ask-patch-option-"]');
    expect(options).toHaveLength(1);
    await box.trigger('keydown', { key: 'Enter' });

    await wrapper.find('[data-test="prompt"]').setValue('What is this?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'What is this?',
      patch_id: 4,
    });
  });
});
