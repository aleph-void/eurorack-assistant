import { defineStore } from 'pinia';
import { api } from '../api.js';

// Linked oscilloscope applications and whichever of them are on the line
// right now. Live connect/disconnect arrives over the same WebSocket as job
// progress, so the patch page can react without polling.
export const useDevicesStore = defineStore('devices', {
  state: () => ({
    devices: [], // issued tokens
    connections: [], // live connections, newest last
    loaded: false,
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
    async fetchDevices() {
      const devices = await api.get('/api/devices');
      this.devices = Array.isArray(devices) ? devices : [];
      this.connections = this.devices.flatMap((d) =>
        Array.isArray(d.connections) ? d.connections : []
      );
      this.loaded = true;
      return this.devices;
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
