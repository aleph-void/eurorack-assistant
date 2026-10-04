import { defineStore } from 'pinia';
import { api } from '../api.js';

// The handful of settings the app draws for everyone — today the Discord
// invite in the footer. Read once per session (App.vue, when someone signs
// in) and put back to blank when they sign out, so the next person at the
// machine sees the link only once the server has said so for them too.
export const useSiteStore = defineStore('site', {
  state: () => ({
    discordInviteUrl: '',
  }),
  actions: {
    async load() {
      try {
        // A footer link's failure to arrive is not news: the footer just
        // goes without it.
        const site = await api.get('/api/site', { quiet: true });
        this.apply(site);
      } catch {
        this.discordInviteUrl = '';
      }
    },
    // What the admin's config page just saved is the new answer, without a
    // second read.
    apply(site) {
      const url = site && !Array.isArray(site) ? site.discord_invite_url : '';
      this.discordInviteUrl = typeof url === 'string' ? url : '';
    },
    reset() {
      this.discordInviteUrl = '';
    },
  },
});
