import { defineStore } from 'pinia';
import { api } from '../api.js';

// Linked oscilloscope applications and whichever of them are on the line
// right now. Live connect/disconnect arrives over the same WebSocket as job
// progress, so the patch page can react without polling — but the events are
// only the CHANGES: a scope that connected before this browser did announces
// nothing, so the list has to be READ once and kept current by the events
// after that (`ensureLoaded`, and again on every socket that comes up, since
// a feed that was down may have missed a connect or a disconnect).
export const useDevicesStore = defineStore('devices', {
  state: () => ({
    devices: [], // issued tokens
    connections: [], // live connections, newest last
    loaded: false,
    loading: false,
  }),
  getters: {
    isConnected: (state) => state.connections.length > 0,
    connectionCount: (state) => state.connections.length,
    // The one a capture would go to when the user has not picked: the most
    // recently connected, matching the server's own choice.
    current: (state) =>
      state.connections.length === 0 ? null : state.connections[state.connections.length - 1],
  },
  actions: {
    async fetchDevices(options) {
      const devices = await api.get('/api/devices', options);
      this.devices = Array.isArray(devices) ? devices : [];
      this.connections = this.devices.flatMap((d) =>
        Array.isArray(d.connections) ? d.connections : []
      );
      this.loaded = true;
      return this.devices;
    },
    // Presence, read in the background for a page that draws it. Its failure
    // is not news — the page says "no scope", which is what a server that
    // cannot be reached amounts to — and a read already in flight is the
    // answer to a second caller.
    async reload() {
      if (this.loading) return this.devices;
      this.loading = true;
      try {
        return await this.fetchDevices({ quiet: true });
      } catch {
        return this.devices;
      } finally {
        this.loading = false;
      }
    },
    // Read once a session: a page that needs to know whether a scope is on
    // the line calls this on mount rather than waiting for an event that
    // only fires when something CHANGES.
    async ensureLoaded() {
      if (this.loaded) return this.devices;
      return this.reload();
    },
    async revoke(id) {
      await api.delete(`/api/devices/${id}`);
      this.devices = this.devices.filter((d) => d.id !== id);
      this.connections = this.connections.filter((c) => c.token_id !== id);
    },
    applyEvent(event) {
      if (event.kind !== 'device' || !event.device) return;
      const idx = this.connections.findIndex((c) => c.id === event.device.id);
      if (event.event === 'disconnected') {
        if (idx !== -1) this.connections.splice(idx, 1);
        return;
      }
      // 'connected' and 'state' both carry the whole announced state.
      if (idx === -1) this.connections.push(event.device);
      else this.connections[idx] = event.device;
    },
  },
});
