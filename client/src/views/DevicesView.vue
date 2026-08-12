<script setup>
import { onMounted, ref } from 'vue';
import { useDevicesStore } from '../stores/devices.js';

// Linked oscilloscope applications: what is connected right now, what each
// one is reading, and revoking any of them.
const devices = useDevicesStore();
const error = ref('');

async function load() {
  error.value = '';
  try {
    await devices.fetchDevices();
  } catch (e) {
    error.value = e.message;
  }
}

async function revoke(device) {
  if (!confirm(`Revoke ${device.name}? It will have to be linked again.`)) return;
  try {
    await devices.revoke(device.id);
  } catch (e) {
    error.value = e.message;
  }
}

// A token's live connections come from the fetch; presence changes after that
// arrive over the WebSocket into the store's flat connection list.
function connectionsFor(device) {
  return devices.connections.filter((c) => c.token_id === device.id);
}

onMounted(load);
</script>

<template>
  <h1>Oscilloscopes</h1>
  <p class="muted">
    An oscilloscope application links itself with a code you approve — open
    <RouterLink to="/link">Link an oscilloscope</RouterLink> and enter the code it shows.
    Once connected, patches can map their scope channels and capture waveforms.
  </p>
  <p v-if="error" class="error" data-test="error">{{ error }}</p>

  <p v-if="devices.loaded && devices.devices.length === 0" class="muted" data-test="empty">
    No oscilloscope has been linked yet.
  </p>

  <div
    v-for="device in devices.devices"
    :key="device.id"
    class="panel"
    :data-test="`device-${device.id}`"
  >
    <h2>
      {{ device.name }}
      <span v-if="connectionsFor(device).length > 0" class="badge running" data-test="connected">
        connected
      </span>
      <span v-else class="badge muted">offline</span>
    </h2>
    <p class="muted">
      {{ device.client_id }} · linked {{ new Date(device.created_at).toLocaleString() }}
      <span v-if="device.last_seen_at">
        · last seen {{ new Date(device.last_seen_at).toLocaleString() }}
      </span>
    </p>

    <div v-for="connection in connectionsFor(device)" :key="connection.id" class="subpanel">
      <p>
        <strong>{{ connection.audio_device?.name || 'unknown audio input' }}</strong>
        <span v-if="connection.audio_device?.channel_count">
          — {{ connection.audio_device.channel_count }} channels
        </span>
        <span v-if="connection.audio_device?.sample_rate">
          at {{ connection.audio_device.sample_rate }} Hz
        </span>
      </p>
      <p v-if="connection.app" class="muted">{{ connection.app }} {{ connection.version }}</p>
      <table v-if="connection.channels?.length" class="grid">
        <thead>
          <tr><th>Channel</th><th>Name</th><th>Type</th></tr>
        </thead>
        <tbody>
          <tr v-for="channel in connection.channels" :key="channel.index">
            <td>{{ channel.index + 1 }}</td>
            <td>{{ channel.name }}</td>
            <td>{{ channel.signal_type }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <button class="danger" :data-test="`revoke-${device.id}`" @click="revoke(device)">
      Revoke
    </button>
  </div>
</template>
