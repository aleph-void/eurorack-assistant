<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useJobsStore } from './stores/jobs.js';
import { useDevicesStore } from './stores/devices.js';
import { createProgressSocket } from './progressSocket.js';
import ConfirmDialog from './components/ConfirmDialog.vue';

const auth = useAuthStore();
const jobs = useJobsStore();
const devices = useDevicesStore();
const router = useRouter();
const route = useRoute();

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

// ---- the menu ----
// The whole nav lives in a drawer, so what it would have shown as a badge
// (running jobs, connected scopes) rides on the closed button instead.
const menuOpen = ref(false);
const liveCount = computed(() => jobs.activeCount + devices.connectionCount);

// Picking a destination is the end of the menu's job.
watch(() => route.fullPath, () => (menuOpen.value = false));

function onKeydown(event) {
  if (event.key === 'Escape') menuOpen.value = false;
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

async function logout() {
  menuOpen.value = false;
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <header v-if="auth.isLoggedIn" class="topbar">
    <button
      class="nav-toggle"
      :class="{ open: menuOpen }"
      type="button"
      aria-label="Menu"
      aria-controls="main-nav"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      data-test="nav-toggle"
      @click="menuOpen = !menuOpen"
    >
      <span class="bar"></span>
      <span class="bar"></span>
      <span class="bar"></span>
      <span v-if="liveCount > 0 && !menuOpen" class="nav-dot" data-test="nav-dot">
        {{ liveCount }}
      </span>
    </button>
    <RouterLink class="brand" to="/modules">
      <img class="brand-mark" src="/logo-white.svg" alt="Aleph Void" />
      <span class="brand-name">Eurorack Assistant</span>
    </RouterLink>
  </header>

  <div v-if="menuOpen" class="nav-scrim" data-test="nav-scrim" @click="menuOpen = false"></div>

  <nav
    v-if="auth.isLoggedIn"
    id="main-nav"
    class="nav-drawer"
    :class="{ open: menuOpen }"
    :aria-hidden="menuOpen ? 'false' : 'true'"
  >
    <p class="nav-heading">Your system</p>
    <RouterLink to="/modules">Modules</RouterLink>
    <RouterLink to="/racks">Racks</RouterLink>
    <RouterLink to="/patches">Patches</RouterLink>
    <RouterLink to="/import">Import</RouterLink>
    <RouterLink to="/search" data-test="nav-search">Search manuals</RouterLink>

    <p class="nav-heading">Assistant</p>
    <RouterLink to="/ask">Ask</RouterLink>
    <RouterLink to="/questions">Questions</RouterLink>
    <RouterLink to="/notes">Notes</RouterLink>

    <p class="nav-heading">Bench</p>
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
      <p class="nav-heading">Admin</p>
      <RouterLink to="/admin/users">Users</RouterLink>
      <RouterLink to="/admin/config">Application Config</RouterLink>
    </template>

    <div class="nav-foot">
      <RouterLink to="/account/password" title="Change password" data-test="account">
        {{ auth.user.username }}
      </RouterLink>
      <a href="#" data-test="logout" @click.prevent="logout">Log out</a>
    </div>
  </nav>

  <main class="container">
    <RouterView />
  </main>

  <!-- Every confirmation in the app is drawn here, whoever asked for it. -->
  <ConfirmDialog />

  <footer class="site-foot">
    <a href="https://github.com/aleph-void/eurorack-assistant" target="_blank" rel="noopener">
      Source on GitHub
    </a>
    <span class="sep" aria-hidden="true">·</span>
    <a href="https://alephvoid.com" target="_blank" rel="noopener">alephvoid.com</a>
  </footer>
</template>
