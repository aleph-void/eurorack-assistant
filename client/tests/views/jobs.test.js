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
import { dialog } from '../../src/dialog.js';
import JobsView from '../../src/views/JobsView.vue';
import { useJobsStore } from '../../src/stores/jobs.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('JobsView', () => {
  it('lists jobs and retries failed ones', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        type: 'find_manual',
        status: 'failed',
        attempts: 3,
        error: 'No manual PDF found',
        module_manufacturer: 'Make Noise',
        module_name: 'Maths',
      },
    ]);
    api.post.mockResolvedValue({ id: 1, status: 'pending', error: null });
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="job-table"]').text()).toContain('Make Noise Maths');
    expect(wrapper.find('[data-test="retry-all"]').text()).toContain('Retry all failed (1)');
    await wrapper.find('[data-test="retry-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/1/retry');
    expect(wrapper.find('[data-test="retry-all"]').exists()).toBe(false);
  });

  it('keeps the newest live progress line fully visible', async () => {
    api.get.mockResolvedValue([]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    const feed = wrapper.find('[data-test="feed"]').element;
    feed.scrollTop = 48;

    useJobsStore().applyEvent({
      kind: 'job',
      event: 'progress',
      at: '2026-08-17T13:05:00Z',
      job: { id: 26, type: 'find_manual' },
      message: 'manual saved: a-very-long-file-name-that-should-wrap-inside-the-live-feed.pdf',
    });
    await flushPromises();

    expect(feed.scrollTop).toBe(0);
    expect(wrapper.find('[data-test="feed"]').text()).toContain('manual saved:');
  });

  it('clears the live log on request, and only locally', async () => {
    api.get.mockResolvedValue([]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="clear-feed"]').attributes('disabled')).toBeDefined();

    const store = useJobsStore();
    store.applyEvent({
      kind: 'job',
      event: 'progress',
      at: '2026-08-17T13:05:00Z',
      job: { id: 26, type: 'find_manual' },
      message: 'manual saved: maths.pdf',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="feed"]').text()).toContain('manual saved:');

    api.delete.mockClear();
    await wrapper.find('[data-test="clear-feed"]').trigger('click');
    await flushPromises();
    expect(store.feed).toEqual([]);
    expect(wrapper.find('[data-test="feed"]').text()).toContain('No live events yet');
    // Nothing to clear on the server: the feed is only what this page saw.
    expect(api.delete).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="clear-feed"]').attributes('disabled')).toBeDefined();
  });

  it('keeps a job row\'s buttons on one line', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'failed', attempts: 3, error: 'No manual PDF found' },
    ]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    const cell = wrapper.find('[data-test="retry-1"]').element.parentElement;
    expect(cell.className).toContain('nowrap');
    expect(cell.parentElement.className).toContain('actions-cell');
  });

  it('retries all failed jobs, but not stalled jobs', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'failed', attempts: 3, error: 'No manual PDF found' },
      { id: 2, type: 'export_rack', status: 'complete', attempts: 1, rack_name: 'main rack' },
      { id: 4, type: 'analyze_manual', status: 'running', stalled: true, attempts: 1 },
      { id: 3, type: 'ask_question', status: 'failed', attempts: 2, error: 'timeout' },
    ]);
    api.post.mockImplementation(async (url) => ({
      id: Number(url.split('/')[3]),
      status: 'pending',
      error: null,
    }));
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="retry-all"]').text()).toContain('Retry all failed (2)');
    await wrapper.find('[data-test="retry-all"]').trigger('click');
    await flushPromises();
    expect(api.post.mock.calls.map((c) => c[0])).toEqual([
      '/api/jobs/1/retry',
      '/api/jobs/3/retry',
    ]);
    // Nothing failed any more, so the button goes away.
    expect(wrapper.find('[data-test="retry-all"]').exists()).toBe(false);
  });

  it('flags a stalled job and offers to retry it', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        type: 'analyze_manual',
        status: 'running',
        stalled: true,
        attempts: 1,
        module_manufacturer: 'Tiptop Audio',
        module_name: 'MISO',
      },
      { id: 2, type: 'analyze_manual', status: 'running', stalled: false, attempts: 1 },
    ]);
    api.post.mockResolvedValue({ id: 1, status: 'pending', stalled: false, error: null });
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="stalled-1"]').exists()).toBe(true);
    // A job that is genuinely still running is neither flagged nor retryable.
    expect(wrapper.find('[data-test="stalled-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="retry-2"]').exists()).toBe(false);
    await wrapper.find('[data-test="retry-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/1/retry');
    expect(wrapper.find('[data-test="stalled-1"]').exists()).toBe(false);
  });

  it('labels rack exports and links the not-yet-taken download', async () => {
    api.get.mockResolvedValue([
      {
        id: 2,
        type: 'export_rack',
        status: 'complete',
        attempts: 1,
        rack_name: 'main rack',
        download: '/api/exports/2',
      },
      { id: 3, type: 'export_rack', status: 'complete', attempts: 1, rack_name: 'travel case', download: null },
    ]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="job-table"]').text()).toContain('main rack');
    const link = wrapper.find('[data-test="download-2"]');
    expect(link.attributes('href')).toBe('/api/exports/2');
    // Already-downloaded exports have no link (the zip is gone).
    expect(wrapper.find('[data-test="download-3"]').exists()).toBe(false);
  });

  it('stops a live job and deletes a finished one', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'analyze_manual', status: 'running', attempts: 1, own: true },
      { id: 2, type: 'find_manual', status: 'complete', attempts: 1, own: true },
    ]);
    api.post.mockResolvedValue({ id: 1, status: 'cancelled', error: 'stopped by user' });
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();

    // A finished job has nothing to stop, only something to delete.
    expect(wrapper.find('[data-test="stop-2"]').exists()).toBe(false);
    await wrapper.find('[data-test="stop-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/1/stop');
    expect(wrapper.find('[data-test="stop-1"]').exists()).toBe(false);

    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(dialog.confirm).toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/jobs/2');
    expect(wrapper.find('[data-test="delete-2"]').exists()).toBe(false);
    vi.restoreAllMocks();
  });

  it('offers Stop All and Delete All over the whole list', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'pending', attempts: 0, own: true },
      { id: 2, type: 'export_rack', status: 'complete', attempts: 1, own: true },
    ]);
    api.post.mockResolvedValue({ stopped: 1 });
    api.delete.mockResolvedValue({ deleted: 2 });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="stop-all"]').text()).toContain('(1)');
    // The refetch after a bulk stop reports what actually settled.
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'cancelled', attempts: 0, own: true },
      { id: 2, type: 'export_rack', status: 'complete', attempts: 1, own: true },
    ]);
    await wrapper.find('[data-test="stop-all"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/stop-all');
    // Nothing left to stop, so the button goes away.
    expect(wrapper.find('[data-test="stop-all"]').exists()).toBe(false);

    await wrapper.find('[data-test="delete-all"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/jobs');
    expect(wrapper.find('[data-test="delete-all"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No jobs yet.');
    vi.restoreAllMocks();
  });

  it('declines to delete when the confirmation is dismissed', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'failed', attempts: 3, own: true },
    ]);
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="delete-1"]').exists()).toBe(true);
    vi.restoreAllMocks();
  });

  it("offers an admin no way to stop or delete another user's job", async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'analyze_manual', status: 'running', attempts: 1, own: false },
      { id: 2, type: 'find_manual', status: 'failed', attempts: 3, own: false },
    ]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="stop-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="delete-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="stop-all"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="delete-all"]').exists()).toBe(false);
    // Retry is still theirs to press — it costs nobody their work.
    expect(wrapper.find('[data-test="retry-2"]').exists()).toBe(true);
  });

  it('clears out the stopped jobs on their own', async () => {
    api.get.mockImplementation(async (url) =>
      url === '/api/jobs/queue'
        ? { paused: false, until: null, reason: '' }
        : [
            { id: 1, type: 'find_manual', status: 'cancelled', attempts: 0, own: true },
            { id: 2, type: 'analyze_manual', status: 'cancelled', attempts: 1, own: true },
            { id: 3, type: 'export_rack', status: 'complete', attempts: 1, own: true },
            // Another user's, from an admin's view of the list.
            { id: 4, type: 'find_manual', status: 'cancelled', attempts: 0, own: false },
          ]
    );
    api.delete.mockResolvedValue({ deleted: 2 });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();

    // Counted over the caller's own cancelled jobs only.
    expect(wrapper.find('[data-test="remove-cancelled"]').text()).toContain('(2)');
    await wrapper.find('[data-test="remove-cancelled"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/jobs/cancelled');
    // Gone from the list, along with the button; the admin's view of someone
    // else's cancelled job stays.
    expect(wrapper.find('[data-test="remove-cancelled"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="job-table"]').text()).not.toContain('analyze_manual');
    expect(wrapper.find('[data-test="delete-4"]').exists()).toBe(false);
    vi.restoreAllMocks();
  });

  it('says when the queue is paused for want of tokens, and starts it again', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    api.get.mockImplementation(async (url) =>
      url === '/api/jobs/queue'
        ? { paused: true, until, reason: 'Claude AI usage limit reached' }
        : [{ id: 1, type: 'find_manual', status: 'pending', attempts: 0, own: true }]
    );
    api.post.mockResolvedValue({ paused: false, until: null, reason: '' });
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();

    const banner = wrapper.find('[data-test="queue-paused"]');
    expect(banner.text()).toContain('Claude AI usage limit reached');
    expect(banner.text()).toContain(new Date(until).toLocaleString());

    await wrapper.find('[data-test="resume-queue"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/queue/resume');
    expect(wrapper.find('[data-test="queue-paused"]').exists()).toBe(false);
  });

  it('says nothing about the queue while it is running', async () => {
    api.get.mockImplementation(async (url) =>
      url === '/api/jobs/queue' ? { paused: false, until: null, reason: '' } : []
    );
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="queue-paused"]').exists()).toBe(false);
  });
});


describe('JobsView budget banner', () => {
  const jobsAnd = (usage) => (path) =>
    Promise.resolve(path === '/api/usage/me' ? usage : path === '/api/jobs/queue' ? {} : []);

  it('says nothing when no budget applies', async () => {
    api.get.mockImplementation(jobsAnd({ unlimited: true, limit: 0, used: 0 }));
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="budget"]').exists()).toBe(false);
  });

  it('explains a queue that is waiting on a spent allowance', async () => {
    api.get.mockImplementation(
      jobsAnd({
        unlimited: false,
        limit: 1000,
        used: 1200,
        remaining: 0,
        period: 'day',
        exhausted: true,
      })
    );
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    const banner = wrapper.find('[data-test="budget"]');
    expect(banner.text()).toContain('Your token budget is spent');
    expect(banner.text()).toContain('last 24 hours');
  });
});
