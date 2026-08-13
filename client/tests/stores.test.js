import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useJobsStore } from '../src/stores/jobs.js';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('auth store', () => {
  it('logs in and exposes admin state', async () => {
    api.post.mockResolvedValue({ id: 1, username: 'admin', is_admin: true });
    const auth = useAuthStore();
    await auth.login('admin', 'pw');
    expect(auth.isLoggedIn).toBe(true);
    expect(auth.isAdmin).toBe(true);
    expect(api.post).toHaveBeenCalledWith('/api/auth/login', { username: 'admin', password: 'pw' });
  });

  it('fetchMe tolerates 401', async () => {
    api.get.mockRejectedValue(new Error('Not authenticated'));
    const auth = useAuthStore();
    expect(await auth.fetchMe()).toBeNull();
    expect(auth.loaded).toBe(true);
    expect(auth.isLoggedIn).toBe(false);
  });

  it('changePassword updates the user and clears the forced flag', async () => {
    api.post.mockResolvedValueOnce({ id: 1, username: 'u', is_admin: false, must_change_password: true });
    const auth = useAuthStore();
    await auth.login('u', 'pw');
    expect(auth.mustChangePassword).toBe(true);

    api.post.mockResolvedValueOnce({ id: 1, username: 'u', is_admin: false, must_change_password: false });
    await auth.changePassword('pw', 'new-pw');
    expect(api.post).toHaveBeenCalledWith('/api/auth/password', {
      current_password: 'pw',
      new_password: 'new-pw',
    });
    expect(auth.mustChangePassword).toBe(false);
  });

  it('logout clears the user even if the call fails', async () => {
    api.post.mockResolvedValueOnce({ id: 1, username: 'u', is_admin: false });
    const auth = useAuthStore();
    await auth.login('u', 'pw');
    api.post.mockRejectedValueOnce(new Error('network'));
    await auth.logout().catch(() => {});
    expect(auth.user).toBeNull();
  });
});

describe('jobs store', () => {
  it('fetches jobs and counts active ones', async () => {
    api.get.mockResolvedValue([
      { id: 1, status: 'pending' },
      { id: 2, status: 'complete' },
      { id: 3, status: 'running' },
    ]);
    const jobs = useJobsStore();
    await jobs.fetchJobs();
    expect(jobs.activeCount).toBe(2);
  });

  it('applies websocket events to the job list and feed', () => {
    const jobs = useJobsStore();
    jobs.jobs = [{ id: 5, status: 'pending', type: 'find_manual' }];

    jobs.applyEvent({
      kind: 'job',
      event: 'progress',
      job: { id: 5, type: 'find_manual', status: 'running' },
      message: 'searching for manual',
      at: 't1',
    });
    expect(jobs.jobs[0].status).toBe('running');
    expect(jobs.feed[0].message).toBe('searching for manual');

    // A started event for an unknown job is added to the list.
    jobs.applyEvent({
      kind: 'job',
      event: 'started',
      job: { id: 9, type: 'import', status: 'running' },
      at: 't2',
    });
    expect(jobs.jobs.map((j) => j.id)).toContain(9);

    // Non-job events are ignored.
    jobs.applyEvent({ kind: 'hello' });
    expect(jobs.feed).toHaveLength(2);
  });

  it('caps the feed length', () => {
    const jobs = useJobsStore();
    jobs.feedLimit = 5;
    for (let i = 0; i < 10; i++) {
      jobs.applyEvent({ kind: 'job', event: 'progress', job: { id: i, type: 't' }, message: `${i}` });
    }
    expect(jobs.feed).toHaveLength(5);
    expect(jobs.feed[0].message).toBe('9');
  });

  it('auto-downloads a finished rack export exactly once', () => {
    const jobs = useJobsStore();
    const downloads = [];
    jobs.triggerDownload = (url) => downloads.push(url);

    jobs.applyEvent({
      kind: 'job',
      event: 'started',
      job: { id: 7, type: 'export_rack', status: 'running', rack_name: 'main rack' },
      at: 't1',
    });
    expect(downloads).toHaveLength(0);

    jobs.applyEvent({
      kind: 'job',
      event: 'completed',
      job: { id: 7, type: 'export_rack', status: 'complete', download: '/api/exports/7' },
      at: 't2',
    });
    expect(downloads).toEqual(['/api/exports/7']);

    // Completions of other job types don't download anything.
    jobs.applyEvent({
      kind: 'job',
      event: 'completed',
      job: { id: 8, type: 'find_manual', status: 'complete' },
      at: 't3',
    });
    expect(downloads).toHaveLength(1);
  });

  it('triggerDownload clicks a temporary anchor pointing at the url', () => {
    const jobs = useJobsStore();
    const clicked = [];
    const anchor = document.createElement('a');
    anchor.click = () => clicked.push(anchor.getAttribute('href'));
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    jobs.triggerDownload('/api/exports/7');
    expect(clicked).toEqual(['/api/exports/7']);
    expect(anchor.hasAttribute('download')).toBe(true);
    expect(document.body.contains(anchor)).toBe(false); // removed after click
    createElement.mockRestore();
  });

  it('retry updates the job in place', async () => {
    api.post.mockResolvedValue({ id: 4, status: 'pending', error: null });
    const jobs = useJobsStore();
    jobs.jobs = [{ id: 4, status: 'failed', error: 'boom', type: 'find_manual' }];
    await jobs.retry(4);
    expect(api.post).toHaveBeenCalledWith('/api/jobs/4/retry');
    expect(jobs.jobs[0].status).toBe('pending');
  });

  it('retryAll retries every failed job and leaves the others alone', async () => {
    api.post.mockImplementation(async (url) => ({
      id: Number(url.split('/')[3]),
      status: 'pending',
      error: null,
    }));
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'failed', error: 'boom', type: 'find_manual' },
      { id: 2, status: 'complete', type: 'export_rack' },
      { id: 3, status: 'failed', error: 'nope', type: 'ask_question' },
    ];
    await jobs.retryAll();
    expect(api.post.mock.calls.map((c) => c[0])).toEqual([
      '/api/jobs/1/retry',
      '/api/jobs/3/retry',
    ]);
    expect(jobs.jobs.map((j) => j.status)).toEqual(['pending', 'complete', 'pending']);
  });

  it('retryAll keeps going past a rejected job and reports it', async () => {
    api.post.mockImplementation(async (url) => {
      if (url === '/api/jobs/1/retry') throw new Error('Only failed jobs can be retried');
      return { id: 3, status: 'pending', error: null };
    });
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'failed', error: 'boom', type: 'find_manual' },
      { id: 3, status: 'failed', error: 'nope', type: 'ask_question' },
    ];
    await expect(jobs.retryAll()).rejects.toThrow('job 1: Only failed jobs can be retried');
    expect(jobs.jobs[1].status).toBe('pending');
  });

  it('stop cancels a job in place and clears its stalled flag', async () => {
    api.post.mockResolvedValue({ id: 4, status: 'cancelled', error: 'stopped by user' });
    const jobs = useJobsStore();
    jobs.jobs = [{ id: 4, status: 'running', stalled: true, type: 'analyze_manual' }];
    await jobs.stop(4);
    expect(api.post).toHaveBeenCalledWith('/api/jobs/4/stop');
    expect(jobs.jobs[0].status).toBe('cancelled');
    expect(jobs.jobs[0].stalled).toBe(false);
  });

  it('stopAll is one request, then refetches the settled list', async () => {
    api.post.mockResolvedValue({ stopped: 2 });
    api.get.mockResolvedValue([{ id: 1, status: 'cancelled' }, { id: 2, status: 'cancelled' }]);
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'pending' },
      { id: 2, status: 'running' },
    ];
    expect(jobs.stoppableJobs).toHaveLength(2);
    expect(await jobs.stopAll()).toEqual({ stopped: 2 });
    expect(api.post).toHaveBeenCalledWith('/api/jobs/stop-all');
    expect(jobs.stoppableJobs).toHaveLength(0);
  });

  it('remove drops one job from the list', async () => {
    api.delete.mockResolvedValue({ ok: true });
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'complete' },
      { id: 2, status: 'failed' },
    ];
    await jobs.remove(1);
    expect(api.delete).toHaveBeenCalledWith('/api/jobs/1');
    expect(jobs.jobs.map((j) => j.id)).toEqual([2]);
  });

  it('deleteAll clears the caller\'s own jobs but keeps the ones they only watch', async () => {
    api.delete.mockResolvedValue({ deleted: 2 });
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'complete', own: true },
      { id: 2, status: 'failed' }, // unmarked — arrived over the socket, so ours
      { id: 3, status: 'running', own: false }, // another user's, admin view
    ];
    expect(jobs.ownJobs.map((j) => j.id)).toEqual([1, 2]);
    // An admin cannot stop someone else's job, so it is not offered either.
    expect(jobs.stoppableJobs).toHaveLength(0);
    expect(await jobs.deleteAll()).toEqual({ deleted: 2 });
    expect(api.delete).toHaveBeenCalledWith('/api/jobs');
    expect(jobs.jobs.map((j) => j.id)).toEqual([3]);
  });

  it('removeCancelled clears the caller\'s stopped jobs and nothing else', async () => {
    api.delete.mockResolvedValue({ deleted: 2 });
    const jobs = useJobsStore();
    jobs.jobs = [
      { id: 1, status: 'cancelled', own: true },
      { id: 2, status: 'cancelled' }, // unmarked — ours
      { id: 3, status: 'failed', own: true },
      { id: 4, status: 'cancelled', own: false }, // another user's, admin view
    ];
    expect(jobs.cancelledJobs.map((j) => j.id)).toEqual([1, 2]);
    expect(await jobs.removeCancelled()).toEqual({ deleted: 2 });
    expect(api.delete).toHaveBeenCalledWith('/api/jobs/cancelled');
    expect(jobs.jobs.map((j) => j.id)).toEqual([3, 4]);
  });

  it('follows the queue being paused and started again', async () => {
    const jobs = useJobsStore();
    expect(jobs.queue.paused).toBe(false);

    api.get.mockResolvedValue({ paused: true, until: '2026-08-13T12:00:00.000Z', reason: 'limit' });
    await jobs.fetchQueue();
    expect(jobs.queue).toEqual({ paused: true, until: '2026-08-13T12:00:00.000Z', reason: 'limit' });

    // Queue events carry no job, and belong in no job's feed.
    jobs.applyEvent({ kind: 'queue', event: 'resumed', paused: false, until: null, reason: '' });
    expect(jobs.queue.paused).toBe(false);
    expect(jobs.feed).toHaveLength(0);

    jobs.applyEvent({
      kind: 'queue',
      event: 'paused',
      paused: true,
      until: '2026-08-13T13:00:00.000Z',
      reason: 'usage limit reached',
    });
    expect(jobs.queue).toEqual({
      paused: true,
      until: '2026-08-13T13:00:00.000Z',
      reason: 'usage limit reached',
    });

    api.post.mockResolvedValue({ paused: false, until: null, reason: '' });
    await jobs.resumeQueue();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/queue/resume');
    expect(jobs.queue.paused).toBe(false);
  });
});
