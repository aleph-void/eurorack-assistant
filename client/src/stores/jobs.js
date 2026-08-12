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
    applyEvent(event) {
      if (event.kind !== 'job' || !event.job) return;
      const idx = this.jobs.findIndex((j) => j.id === event.job.id);
      if (idx !== -1) {
        this.jobs[idx] = { ...this.jobs[idx], ...event.job };
      } else if (event.event === 'started') {
        this.jobs.unshift({ ...event.job });
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
  },
});
