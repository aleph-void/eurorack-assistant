<script setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useJobsStore } from './stores/jobs.js';
import { useDevicesStore } from './stores/devices.js';
import { useDetailStore } from './stores/detail.js';
import { createProgressSocket } from './progressSocket.js';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ToastStack from './components/ToastStack.vue';
import { loadVoiceSettings, resetVoiceSettings, voiceSettings } from './voiceSettings.js';

// The listener is the speech engines, the activation layer, the parser and
// the tones — the largest thing in the app that most sessions never use. It
// is fetched the moment voice patching is switched on and not before, which
// is why `voiceSettings.js` itself imports nothing.
const VoicePatchPanel = defineAsyncComponent(() => import('./components/VoicePatchPanel.vue'));

const auth = useAuthStore();
const jobs = useJobsStore();
const devices = useDevicesStore();
const detail = useDetailStore();
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

// Voice patching is set up per account and kept in this browser, so which
// settings are in force follows who is signed in. Signing out puts them back
// to the defaults: a studio machine is logged into by more than one person,
// and the next one must not inherit a microphone — or an 'on'.
function loadVoiceFor(user) {
  if (user?.id) loadVoiceSettings(user.id);
  else resetVoiceSettings();
}
watch(() => auth.user?.id, () => loadVoiceFor(auth.user), { immediate: true });

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

// ---- the record the reader is inside ----
// A module and a patch are each a dozen routes over one record. Whichever of
// them is open says so (stores/detail.js), and the drawer answers with that
// record's own pages, at the top, above the rest of the app.
// Every kind of thing on a panel is a page of its own — the jacks by what a
// cable does at them, the rest by their type. The list of ALL of a module's
// components is still there; it is just not where you go to find the knobs.
const MODULE_PAGES = [
  { path: '', label: 'Front panel & summary', exact: true },
  { path: '/jacks/input', label: 'Input jacks' },
  { path: '/jacks/output', label: 'Output jacks' },
  { path: '/jacks/bidirectional', label: 'Bidirectional jacks' },
  { path: '/parts/knob', label: 'Knobs' },
  { path: '/parts/slider', label: 'Sliders' },
  { path: '/parts/button', label: 'Buttons' },
  { path: '/parts/toggle', label: 'Toggles' },
  { path: '/parts/switch', label: 'Switches' },
  { path: '/parts/display', label: 'Displays' },
  { path: '/parts/other', label: 'Other components' },
  { path: '/components', label: 'Components' },
  { path: '/values', label: 'Component values' },
  { path: '/parameters', label: 'Menu parameters' },
  { path: '/normalizations', label: 'Normalled connections' },
  { path: '/switches', label: 'Routing switches' },
  { path: '/routes', label: 'Internal signal paths' },
  { path: '/pairs', label: 'Stereo pairs' },
  { path: '/expanders', label: 'Expander panels' },
  { path: '/bridges', label: 'Dual panels' },
  { path: '/documents', label: 'Documents' },
  { path: '/videos', label: 'Videos' },
  { path: '/notes', label: 'Your notes' },
  { path: '/questions', label: 'Questions' },
];

const PATCH_PAGES = [
  { path: '', label: 'Diagram', exact: true },
  { path: '/cables', label: 'Cables' },
  { path: '/settings', label: 'Control settings' },
  { path: '/flow', label: 'Signal flow' },
  { path: '/links', label: 'Links, buses & gear' },
  { path: '/scope', label: 'Oscilloscope' },
  { path: '/notes', label: 'Notes' },
  { path: '/modules', label: 'Modules in this patch' },
  { path: '/questions', label: 'Questions' },
];

const detailPages = computed(() => (detail.kind === 'patch' ? PATCH_PAGES : MODULE_PAGES));
const detailHeading = computed(() => detail.label || (detail.kind === 'patch' ? 'This patch' : 'This module'));

// Previous/next stay in the rack the reader came from, so the sub-page links
// have to carry it as well or the walk through a rack ends at the first jump.
const detailBase = computed(() => {
  if (!detail.kind || !detail.id) return null;
  return detail.kind === 'patch' ? `/patches/${detail.id}` : `/modules/${detail.id}`;
});
const detailSuffix = computed(() =>
  detail.kind === 'module' && route.query.rack ? `?rack=${route.query.rack}` : ''
);
const detailHref = (page) => `${detailBase.value}${page.path}${detailSuffix.value}`;

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
    <template v-if="detailBase">
      <p class="nav-heading" data-test="nav-detail-heading">{{ detailHeading }}</p>
      <RouterLink
        v-for="page in detailPages"
        :key="page.path"
        :to="detailHref(page)"
        class="nav-sub"
        :active-class="page.exact ? '' : 'router-link-active'"
        :data-test="`nav-detail-${page.path.slice(1) || 'index'}`"
      >
        {{ page.label }}
      </RouterLink>
    </template>

    <p class="nav-heading">Your system</p>
    <RouterLink to="/modules">Modules</RouterLink>
    <RouterLink to="/racks">Racks</RouterLink>
    <RouterLink to="/systems" data-test="nav-systems">Systems</RouterLink>
    <RouterLink to="/patches">Patches</RouterLink>
    <RouterLink to="/import">Import</RouterLink>
    <RouterLink to="/search" data-test="nav-search">Search manuals</RouterLink>
    <RouterLink to="/shared" data-test="nav-shared">Shared</RouterLink>

    <p class="nav-heading">Assistant</p>
    <RouterLink to="/ask">Ask</RouterLink>
    <RouterLink to="/questions">Questions</RouterLink>
    <RouterLink to="/notes">Notes</RouterLink>
    <RouterLink to="/account/llm" data-test="nav-llm">LLM account</RouterLink>
    <RouterLink to="/account/voice" data-test="nav-voice">Patch by voice</RouterLink>

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
      <RouterLink to="/admin/csp-reports" data-test="nav-csp-reports">
        Policy violations
      </RouterLink>
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

  <!-- Patching by voice is switched on under the account rather than on a
       page, so the listener is mounted once here and works over whichever
       patch diagram is open. It draws nothing until both are true. -->
  <VoicePatchPanel v-if="auth.isLoggedIn && voiceSettings.enabled" />

  <!-- Every confirmation in the app is drawn here, whoever asked for it. -->
  <ConfirmDialog />
  <!-- Outside the logged-in branch: a failed login is worth a toast too. -->
  <ToastStack />

  <footer class="site-foot">
    <a href="https://github.com/aleph-void/eurorack-assistant" target="_blank" rel="noopener">
      Source on GitHub
    </a>
    <span class="sep" aria-hidden="true">·</span>
    <a href="https://alephvoid.com" target="_blank" rel="noopener">alephvoid.com</a>
  </footer>
</template>
