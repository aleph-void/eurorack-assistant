import { defineStore } from 'pinia';
import { api } from '../api.js';

// Queue state as the store keeps it, from an API response or a socket event.
const asQueue = (queue) => ({
  paused: Boolean(queue?.paused),
  until: queue?.until ?? null,
  reason: queue?.reason || '',
});

// The viewer's own LLM account pause (out of tokens), same shape plus which
// provider hit the wall.
const asLlmPause = (event) => ({
  paused: Boolean(event?.paused),
  provider: event?.provider || '',
  until: event?.until ?? null,
  reason: event?.reason || '',
});

// Job list + live progress feed. WebSocket events land here via applyEvent().
export const useJobsStore = defineStore('jobs', {
  state: () => ({
    jobs: [],
    feed: [], // recent progress lines, newest first
    feedLimit: 200,
    // The queue stops itself when the LLM provider reports the subscription
    // is out of tokens; `until` is when it will start again on its own.
    queue: { paused: false, until: null, reason: '' },
    // The viewer's own account hit its provider's token wall; only their
    // jobs wait (everyone runs on their own subscription).
    llmPause: { paused: false, provider: '', until: null, reason: '' },
  }),
  getters: {
    activeCount: (state) =>
      state.jobs.filter((j) => j.status === 'pending' || j.status === 'running').length,
    failedJobs: (state) => state.jobs.filter((j) => j.status === 'failed'),
    // Stalled jobs are still 'running', but the worker holding them died —
    // the server reclaims them on its next pass and accepts a retry meanwhile.
    retryableJobs: (state) => state.jobs.filter((j) => j.status === 'failed' || j.stalled),
    // Stopping and deleting are owner-only: an admin's list also holds other
    // users' jobs, which they may watch and retry but not throw away. The
    // list marks each row; anything unmarked (a job that arrived over the
    // socket) is by definition the viewer's own.
    ownJobs: (state) => state.jobs.filter((j) => j.own !== false),
    // Own jobs the queue still has designs on — what Stop All applies to.
    stoppableJobs: (state) =>
      state.jobs.filter((j) => j.own !== false && (j.status === 'pending' || j.status === 'running')),
    // Own jobs the user stopped — what Remove Cancelled clears out.
    cancelledJobs: (state) => state.jobs.filter((j) => j.own !== false && j.status === 'cancelled'),
  },
  actions: {
    async fetchJobs() {
      this.jobs = await api.get('/api/jobs');
      return this.jobs;
    },
    // Whether the queue is running. Live updates arrive over the socket; this
    // is for a page that was opened after it stopped.
    async fetchQueue() {
      this.queue = asQueue(await api.get('/api/jobs/queue'));
      return this.queue;
    },
    async resumeQueue() {
      this.queue = asQueue(await api.post('/api/jobs/queue/resume'));
      return this.queue;
    },
    // Whether the viewer's own LLM account is paused for quota. Live updates
    // arrive over the socket; this is for a page opened after it stopped.
    async fetchLlmPause() {
      const status = await api.get('/api/llm');
      const account = status.accounts?.[status.effective_provider] || null;
      this.llmPause = asLlmPause({
        paused: Boolean(account?.paused_until),
        provider: status.effective_provider,
        until: account?.paused_until ?? null,
        reason: account?.paused_reason || '',
      });
      return this.llmPause;
    },
    async resumeLlm() {
      if (this.llmPause.provider) {
        await api.post(`/api/llm/${this.llmPause.provider}/resume`);
      }
      this.llmPause = asLlmPause({ provider: this.llmPause.provider });
      return this.llmPause;
    },
    async retry(jobId) {
      const updated = await api.post(`/api/jobs/${jobId}/retry`);
      const idx = this.jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) this.jobs[idx] = { ...this.jobs[idx], ...updated };
      return updated;
    },
    // Retry failed jobs only, one at a time so the queue picks them up in the
    // order they are listed. A stalled job can still be investigated or
    // retried deliberately from its own row. One job refusing (already
    // retried elsewhere, for instance) must not strand the rest, so failures
    // are collected and reported after the whole sweep.
    async retryAll() {
      const failures = [];
      for (const job of this.failedJobs.slice()) {
        try {
          await this.retry(job.id);
        } catch (e) {
          failures.push(`job ${job.id}: ${e.message}`);
        }
      }
      if (failures.length) throw new Error(`Some jobs could not be retried — ${failures.join('; ')}`);
    },
    // Stopping takes a job off the queue; a job already running is left to
    // finish in the background and its result discarded by the worker, so the
    // row goes to 'cancelled' either way.
    async stop(jobId) {
      const updated = await api.post(`/api/jobs/${jobId}/stop`);
      const idx = this.jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) this.jobs[idx] = { ...this.jobs[idx], ...updated, stalled: false };
      return updated;
    },
    // Bulk stop and delete are one request each rather than a sweep of
    // per-job calls: the set to act on is decided by the server, so jobs that
    // started (or finished) since the list was fetched are handled correctly.
    async stopAll() {
      const result = await api.post('/api/jobs/stop-all');
      await this.fetchJobs();
      return result;
    },
    async remove(jobId) {
      await api.delete(`/api/jobs/${jobId}`);
      this.jobs = this.jobs.filter((j) => j.id !== jobId);
    },
    // Only the caller's own jobs are deleted, so an admin's view of everyone
    // else's survives — refetch rather than assuming an empty list.
    async deleteAll() {
      const result = await api.delete('/api/jobs');
      this.jobs = this.jobs.filter((j) => j.own === false);
      return result;
    },
    // Throw away the jobs the user stopped. Cancelled jobs of other users
    // (an admin's list holds them) are the server's to leave alone, so the
    // local list is filtered the same way the request is scoped.
    async removeCancelled() {
      const result = await api.delete('/api/jobs/cancelled');
      this.jobs = this.jobs.filter((j) => j.own === false || j.status !== 'cancelled');
      return result;
    },
    applyEvent(event) {
      // The queue stopping or starting is about the whole queue rather than
      // about one job, and carries no job to fold into the list.
      if (event.kind === 'queue') {
        this.queue = asQueue(event);
        return;
      }
      // The viewer's own account pausing (or resuming) is personal queue
      // state: it explains why their jobs sit still while others' run.
      if (event.kind === 'llm_account') {
        this.llmPause = asLlmPause(event);
        return;
      }
      if (event.kind !== 'job' || !event.job) return;
      const idx = this.jobs.findIndex((j) => j.id === event.job.id);
      if (idx !== -1) {
        this.jobs[idx] = { ...this.jobs[idx], ...event.job };
      } else if (event.event === 'started') {
        this.jobs.unshift({ ...event.job });
      }
      // A finished rack export downloads itself; the server deletes the zip
      // once it has been served, so the link in the job row goes stale after.
      if (event.event === 'completed' && event.job.type === 'export_rack' && event.job.download) {
        this.triggerDownload(event.job.download);
      }
      this.feed.unshift({
        at: event.at,
        jobId: event.job.id,
        type: event.job.type,
        event: event.event,
        message: event.message || event.event,
      });
      if (this.feed.length > this.feedLimit) this.feed.length = this.feedLimit;
    },
    // Wipe the live feed. Purely local: the lines are only ever what this
    // page has seen since it opened, so there is nothing on the server to
    // clear and new events start filling it again straight away.
    clearFeed() {
      this.feed = [];
    },
    // Navigate an invisible anchor so the browser saves the file without
    // leaving the page.
    triggerDownload(url) {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  },
});
