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
import PerformancesView from '../../src/views/PerformancesView.vue';
import { performancePage } from '../performanceFixtures.js';

// The list, then whatever the share form asks for when it opens.
function answer({ page = performancePage, patches = [], modules = [] } = {}) {
  api.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/performances')) return page;
    if (path.startsWith('/api/patches')) return { patches, total: patches.length, has_more: false };
    if (path === '/api/modules') return modules;
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PerformancesView', () => {
  it('lists everyone s performances, newest first, saying whose and how open', async () => {
    answer();
    const wrapper = mount(PerformancesView, { global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/performances?limit=50');
    const rows = wrapper.findAll('[data-test^="performance-"]').filter((r) => r.element.tagName === 'TR');
    expect(rows.map((r) => r.text())).toEqual([
      expect.stringContaining('Kitchen table drone'),
      expect.stringContaining('Evening set'),
    ]);
    const bobs = wrapper.find('[data-test="performance-7"]');
    expect(bobs.text()).toContain('bob');
    expect(bobs.find('[data-test="public-badge"]').exists()).toBe(true);
    expect(bobs.find('[data-test="mine-badge"]').exists()).toBe(false);
    const mine = wrapper.find('[data-test="performance-3"]');
    expect(mine.find('[data-test="mine-badge"]').exists()).toBe(true);
    expect(mine.text()).toContain('patch shown');
    // The share form waits to be asked for, and reads nothing until then.
    expect(wrapper.find('[data-test="performance-form"]').exists()).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('shares a video with its patch and modules, then opens its page', async () => {
    answer({
      page: { ...performancePage, performances: [], total: 0 },
      patches: [{ id: 12, name: 'Krell', rack_name: 'main rack' }],
      modules: [
        { id: 5, manufacturer: 'Make Noise', name: 'Maths' },
        { id: 6, manufacturer: 'Mutable', name: 'Plaits' },
      ],
    });
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(PerformancesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="no-performances"]').exists()).toBe(true);

    await wrapper.find('[data-test="open-share"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="performance-url"]').setValue('https://youtu.be/dQw4w9WgXcQ');
    await wrapper.find('[data-test="performance-title"]').setValue('First take');
    await wrapper.find('[data-test="performance-description"]').setValue('Still rough');
    await wrapper.find('[data-test="performance-public"]').setValue(true);
    await wrapper.find('[data-test="performance-patch"]').setValue('12');
    // Typing narrows the module list to what matches; ticking one keeps it.
    await wrapper.find('[data-test="module-filter"]').setValue('pla');
    expect(wrapper.findAll('[data-test="module-list"] li')).toHaveLength(1);
    await wrapper.find('[data-test="module-6"]').setValue(true);
    expect(wrapper.find('[data-test="module-count"]').text()).toBe('1');
    await wrapper.find('[data-test="performance-form"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/performances', {
      url: 'https://youtu.be/dQw4w9WgXcQ',
      title: 'First take',
      description: 'Still rough',
      public: true,
      patch_id: 12,
      module_ids: [6],
    });
    expect(routerPush).toHaveBeenCalledWith('/performances/9');
  });

  it('says what went wrong when the link is refused', async () => {
    answer();
    api.post.mockRejectedValue(new Error('That is not a link to a YouTube video'));
    const wrapper = mount(PerformancesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="open-share"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="performance-url"]').setValue('https://vimeo.com/1');
    await wrapper.find('[data-test="performance-title"]').setValue('x');
    await wrapper.find('[data-test="performance-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('not a link to a YouTube video');
    expect(routerPush).not.toHaveBeenCalled();
  });
});
