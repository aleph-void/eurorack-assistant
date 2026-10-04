import { defineStore } from 'pinia';
import { api } from '../api.js';

// What the daily backup last reported (GET /api/backups: the status and the
// recent runs). Admin-only on the server, so the shell asks only for an
// admin, and asks QUIETLY — a 403 or a server that is down is not news a
// toast should bring on every page.
//
// `problem` is the server's one line about the last run (failed, or no
// success in two days), or null; the shell draws it as a banner over every
// page while it is set, which is how an admin who never opens the Backups
// page still hears about a failed one.

// How long the status is trusted before a page change re-reads it: a backup
// is a once-a-day event, and a status read this morning is still right at
// lunch.
export const STATUS_MAX_AGE_MS = 10 * 60 * 1000;

export const useBackupsStore = defineStore('backups', {
  state: () => ({
    status: null,
    loadedAt: 0,
    loading: false,
  }),
  getters: {
    problem: (state) => state.status?.problem || null,
    runs: (state) => state.status?.runs || [],
  },
  actions: {
    async load() {
      this.loading = true;
      try {
        this.status = (await api.get('/api/backups', { quiet: true })) || null;
        this.loadedAt = Date.now();
      } catch {
        this.status = null;
      } finally {
        this.loading = false;
      }
      return this.status;
    },
    // A read only when the one in hand is old: what the shell calls on every
    // page change, so a failure that landed overnight is on screen by the
    // second page of the morning without a poll.
    async refresh({ now = Date.now() } = {}) {
      if (this.loading || now - this.loadedAt < STATUS_MAX_AGE_MS) return this.status;
      return this.load();
    },
    forget() {
      this.status = null;
      this.loadedAt = 0;
    },
  },
});
