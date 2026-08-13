import { defineStore } from 'pinia';
import { api } from '../api.js';

// Job list + live progress feed. WebSocket events land here via applyEvent().
export const useJobsStore = defineStore('jobs', {
  state: () => ({
    jobs: [],
    feed: [], // recent progress lines, newest first
    feedLimit: 200,
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
  },
  actions: {
    async fetchJobs() {
      this.jobs = await api.get('/api/jobs');
      return this.jobs;
    },
    async retry(jobId) {
      const updated = await api.post(`/api/jobs/${jobId}/retry`);
      const idx = this.jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) this.jobs[idx] = { ...this.jobs[idx], ...updated };
      return updated;
    },
    // Retry every failed or stalled job, one at a time so the queue picks them
    // up in the order they are listed. One job refusing (already retried
    // elsewhere, for instance) must not strand the rest, so failures are
    // collected and reported after the whole sweep.
    async retryAll() {
      const failures = [];
      for (const job of this.retryableJobs.slice()) {
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
    applyEvent(event) {
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
