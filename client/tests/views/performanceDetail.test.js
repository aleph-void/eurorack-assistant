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
    useRouter: () => ({ push: routerPush, replace: vi.fn() }),
    useRoute: () => ({ fullPath: '/performances/3', params: { id: '3' }, query: {} }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import { useAuthStore } from '../../src/stores/auth.js';
import PerformanceDetailView from '../../src/views/PerformanceDetailView.vue';
import { performance, performancePatch } from '../performanceFixtures.js';

// Mounted as a signed-in user unless `user` says otherwise (null for a
// visitor with no session).
function mountAs(user = { id: 2, username: 'bob' }) {
  const global = testGlobal();
  const auth = useAuthStore();
  auth.user = user;
  auth.loaded = true;
  return mount(PerformanceDetailView, { props: { id: '3' }, global });
}

function answer({ page = performance, patch = performancePatch, patches = [] } = {}) {
  api.get.mockImplementation(async (path) => {
    if (path === '/api/performances/3') return page;
    if (path === '/api/performances/3/patch') return patch;
    if (path.startsWith('/api/patches')) return { patches };
    if (path === '/api/modules') return [];
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PerformanceDetailView', () => {
  it('embeds the video from its id and shows what the author said', async () => {
    answer();
    const wrapper = mountAs();
    await flushPromises();

    expect(wrapper.find('[data-test="title"]').text()).toBe('Evening set');
    expect(wrapper.find('[data-test="byline"]').text()).toContain('alice');
    // The player comes from the privacy host and nothing user-typed reaches it.
    expect(wrapper.find('[data-test="video"]').attributes('src')).toBe(
      'https://www.youtube-nocookie.com/embed/abcdefghijk'
    );
    expect(wrapper.find('[data-test="watch-link"]').attributes('href')).toBe(performance.url);
    expect(wrapper.find('[data-test="description"]').text()).toContain('Listen for the sub.');
  });

  it('names the modules, linking the ones the viewer has', async () => {
    answer();
    const wrapper = mountAs();
    await flushPromises();
    const maths = wrapper.find('[data-test="module-5"]');
    expect(maths.find('a').exists()).toBe(true);
    expect(maths.text()).toContain('Make Noise Maths');
    const plaits = wrapper.find('[data-test="module-6"]');
    expect(plaits.find('a').exists()).toBe(false);
    expect(plaits.text()).toContain('Mutable Plaits');
  });

  it('reads the patch only when asked, and draws it with its cables and settings', async () => {
    answer();
    const wrapper = mountAs();
    await flushPromises();
    expect(api.get).not.toHaveBeenCalledWith('/api/performances/3/patch');

    await wrapper.find('[data-test="toggle-patch"]').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/performances/3/patch');
    expect(wrapper.find('[data-test="patch-cables"]').text()).toContain('Maths EOR → Plaits Trigger');
    expect(wrapper.find('[data-test="patch-settings"]').text()).toContain('Plaits Model: Chords');
  });

  it('says when the patch has gone, or was never shown', async () => {
    answer({ page: { ...performance, patch: { id: null, name: 'Krell', live: false } } });
    let wrapper = mountAs();
    await flushPromises();
    expect(wrapper.find('[data-test="patch-gone"]').text()).toContain("'Krell'");

    answer({ page: { ...performance, patch: null } });
    wrapper = mountAs();
    await flushPromises();
    expect(wrapper.find('[data-test="no-patch"]').exists()).toBe(true);
  });

  it('posts a comment and removes the ones the viewer may', async () => {
    answer();
    api.post.mockResolvedValue({
      id: 3,
      username: 'bob',
      body: 'One more thing',
      mine: true,
      can_delete: true,
      created_at: '2026-10-02T10:00:00Z',
    });
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mountAs();
    await flushPromises();

    expect(wrapper.findAll('[data-test^="comment-"]').filter((c) => c.element.tagName === 'LI')).toHaveLength(2);
    // Bob may remove his own and not alice's.
    expect(wrapper.find('[data-test="remove-comment-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remove-comment-2"]').exists()).toBe(false);

    await wrapper.find('[data-test="comment-body"]').setValue('One more thing');
    await wrapper.find('[data-test="comment-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/performances/3/comments', { body: 'One more thing' });
    expect(wrapper.find('[data-test="comment-3"]').text()).toContain('One more thing');

    await wrapper.find('[data-test="remove-comment-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/performances/3/comments/1');
    expect(wrapper.find('[data-test="comment-1"]').exists()).toBe(false);
  });

  it('shows a public performance to a visitor with no session, who is asked to log in to comment', async () => {
    answer({ page: { ...performance, public: true, comments: [] } });
    const wrapper = mountAs(null);
    await flushPromises();
    expect(wrapper.find('[data-test="video"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="public-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="comment-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="comment-login"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="author-section"]').exists()).toBe(false);
  });

  it('invites a visitor to log in at a private one', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('Log in to see this performance'), { status: 401 }));
    const wrapper = mountAs(null);
    await flushPromises();
    expect(wrapper.find('[data-test="needs-login"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="login-link"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="video"]').exists()).toBe(false);
  });

  it('lets the author edit, with the form already filled in, and delete', async () => {
    const mine = { ...performance, mine: true, can_delete: true };
    answer({ page: mine, patches: [{ id: 12, name: 'Krell', rack_name: 'main rack' }] });
    api.put.mockResolvedValue({ ...mine, title: 'Late set', public: true, updated_at: 'later' });
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mountAs({ id: 1, username: 'alice' });
    await flushPromises();

    await wrapper.find('[data-test="edit"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="performance-title"]').element.value).toBe('Evening set');
    expect(wrapper.find('[data-test="performance-patch"]').element.value).toBe('12');
    await wrapper.find('[data-test="performance-title"]').setValue('Late set');
    await wrapper.find('[data-test="performance-public"]').setValue(true);
    await wrapper.find('[data-test="performance-form"]').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      '/api/performances/3',
      expect.objectContaining({ title: 'Late set', public: true, patch_id: 12 })
    );
    expect(wrapper.find('[data-test="title"]').text()).toBe('Late set');
    expect(wrapper.find('[data-test="performance-form"]').exists()).toBe(false);

    await wrapper.find('[data-test="delete"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/performances/3');
    expect(routerPush).toHaveBeenCalledWith('/performances');
  });
});
