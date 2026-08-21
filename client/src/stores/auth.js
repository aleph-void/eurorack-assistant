import { defineStore } from 'pinia';
import { api } from '../api.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    loaded: false,
  }),
  getters: {
    isLoggedIn: (state) => !!state.user,
    isAdmin: (state) => !!state.user?.is_admin,
    mustChangePassword: (state) => !!state.user?.must_change_password,
  },
  actions: {
    async fetchMe() {
      try {
        // Asked on every page load; "nobody" is an ordinary answer.
        this.user = await api.get('/api/auth/me', { quiet: true });
      } catch {
        this.user = null;
      } finally {
        this.loaded = true;
      }
      return this.user;
    },
    async login(username, password) {
      this.user = await api.post('/api/auth/login', { username, password });
      this.loaded = true;
      return this.user;
    },
    async changePassword(currentPassword, newPassword) {
      this.user = await api.post('/api/auth/password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      return this.user;
    },
    async logout() {
      try {
        await api.post('/api/auth/logout');
      } finally {
        this.user = null;
      }
    },
  },
});
