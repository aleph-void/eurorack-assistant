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
import ImportView from '../../src/views/ImportView.vue';
import { useJobsStore } from '../../src/stores/jobs.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ImportView', () => {
  // ImportView loads the user's racks on mount to populate the rack selector.
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 1 },
    { id: 2, name: 'travel case', module_count: 0 },
  ];

  it('submits a text import into the default rack and shows the queued job', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 42, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="content"]').setValue('Make Noise,Maths');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'Make Noise,Maths',
      rack: 'main rack',
    });
    expect(wrapper.find('[data-test="queued"]').text()).toContain('#42');
    expect(wrapper.find('[data-test="feed"]').exists()).toBe(true);
  });

  it('submits a modulargrid import', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 1, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="mode"]').setValue('modulargrid');
    await wrapper.find('[data-test="url"]').setValue('https://modulargrid.net/e/racks/view/1');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'modulargrid',
      url: 'https://modulargrid.net/e/racks/view/1',
      rack: 'main rack',
    });
  });

  it('imports into a selected existing rack', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 2, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(2);
    await wrapper.find('[data-test="content"]').setValue('ALM,Pam');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'ALM,Pam',
      rack: 'travel case',
    });
  });

  it('creates a new rack to import into', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 3, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack"]').exists()).toBe(false);
    await wrapper.find('[data-test="rack-select"]').setValue('');
    await wrapper.find('[data-test="rack"]').setValue('modular on the go');
    await wrapper.find('[data-test="content"]').setValue('ALM,Pam');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'ALM,Pam',
      rack: 'modular on the go',
    });
  });

  it('defaults to creating a new rack when the user has none', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({ job_id: 4, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack"]').exists()).toBe(true);
    await wrapper.find('[data-test="rack"]').setValue('first rack');
    await wrapper.find('[data-test="content"]').setValue('Make Noise,Maths');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'Make Noise,Maths',
      rack: 'first rack',
    });
  });

  it('shows live progress lines from the jobs store', async () => {
    api.post.mockResolvedValue({ job_id: 7, status: 'pending' });
    const global = testGlobal();
    const wrapper = mount(ImportView, { global });
    await wrapper.find('[data-test="content"]').setValue('x');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const jobs = useJobsStore();
    jobs.applyEvent({
      kind: 'job',
      event: 'progress',
      job: { id: 7, type: 'import' },
      message: 'created: Make Noise Maths',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="feed"]').text()).toContain('created: Make Noise Maths');
  });

  it('surfaces API errors', async () => {
    api.post.mockRejectedValue(new Error('content is required'));
    const wrapper = mount(ImportView, { global: testGlobal() });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('content is required');
  });
});
