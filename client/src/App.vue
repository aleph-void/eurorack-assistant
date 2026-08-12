<script setup>
import { onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useJobsStore } from './stores/jobs.js';
import { useDevicesStore } from './stores/devices.js';
import { createProgressSocket } from './progressSocket.js';

const auth = useAuthStore();
const jobs = useJobsStore();
const devices = useDevicesStore();
const router = useRouter();

let socket = null;

// One socket, two consumers: job progress and oscilloscope presence.
function dispatch(event) {
  if (event.kind === 'device') devices.applyEvent(event);
  else jobs.applyEvent(event);
}

function ensureSocket() {
  if (auth.isLoggedIn && !socket) {
    socket = createProgressSocket({ onEvent: dispatch });
  } else if (!auth.isLoggedIn && socket) {
    socket.close();
    socket = null;
  }
}

watch(() => auth.isLoggedIn, ensureSocket);
onMounted(ensureSocket);
onUnmounted(() => socket?.close());

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <nav v-if="auth.isLoggedIn" class="topbar">
    <span class="brand">Eurorack Assistant</span>
    <RouterLink to="/modules">Modules</RouterLink>
    <RouterLink to="/racks">Racks</RouterLink>
    <RouterLink to="/patches">Patches</RouterLink>
    <RouterLink to="/import">Import</RouterLink>
    <RouterLink to="/ask">Ask</RouterLink>
    <RouterLink to="/questions">Questions</RouterLink>
    <RouterLink to="/notes">Notes</RouterLink>
    <RouterLink to="/devices" data-test="nav-devices">
      Devices
      <span v-if="devices.connectionCount > 0" class="badge running">
        {{ devices.connectionCount }}
      </span>
    </RouterLink>
    <RouterLink to="/jobs">
      Jobs
      <span v-if="jobs.activeCount > 0" class="badge running">{{ jobs.activeCount }}</span>
    </RouterLink>
    <template v-if="auth.isAdmin">
      <RouterLink to="/admin/users">Users</RouterLink>
      <RouterLink to="/admin/config">Application Config</RouterLink>
    </template>
    <span class="spacer"></span>
    <RouterLink class="muted" to="/account/password" title="Change password" data-test="account">
      {{ auth.user.username }}
    </RouterLink>
    <a href="#" data-test="logout" @click.prevent="logout">Log out</a>
  </nav>
  <main class="container">
    <RouterView />
  </main>
</template>
