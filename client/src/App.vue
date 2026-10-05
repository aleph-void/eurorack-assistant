<script setup>
import { nextTick, computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useJobsStore } from './stores/jobs.js';
import { useDevicesStore } from './stores/devices.js';
import RecordNavigation from './components/RecordNavigation.vue';
import { useDetailStore } from './stores/detail.js';
import { NAVIGATION_GROUPS, findDestination } from './navigation.js';
import { useSiteStore } from './stores/site.js';
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
const visibleGroups = computed(() => NAVIGATION_GROUPS.filter((group) => !group.admin || auth.isAdmin));
const site = useSiteStore();
const router = useRouter();
const route = useRoute();
const currentDestination = computed(() => findDestination(route.path || route.fullPath?.split('?')[0]));

let socket = null;

// One socket, two consumers: job progress and oscilloscope presence.
function dispatch(event) {
  if (event.kind === 'device') devices.applyEvent(event);
  else jobs.applyEvent(event);
}

function ensureSocket() {
  if (auth.isLoggedIn && !socket) {
    socket = createProgressSocket({ onEvent: dispatch, onOpen: () => devices.reload() });
  } else if (!auth.isLoggedIn && socket) {
    socket.close();
    socket = null;
  }
}

watch(() => auth.isLoggedIn, ensureSocket);
onMounted(ensureSocket);
onUnmounted(() => socket?.close());

// The footer's community link is a setting every signed-in user may read
// and nobody else: read when someone signs in, forgotten when they sign out.
watch(
  () => auth.isLoggedIn,
  (loggedIn) => (loggedIn ? site.load() : site.reset()),
  { immediate: true }
);

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
// Global destinations live in the drawer, so what it would show as a badge
// (running jobs, connected scopes) rides on the closed button instead.
const menuOpen = ref(false);
const menuButton = ref(null);
const menuDrawer = ref(null);
const primaryGroups = NAVIGATION_GROUPS.filter((group) =>
  ['system', 'music', 'knowledge', 'tools'].includes(group.key)
);
const currentGroup = computed(() => NAVIGATION_GROUPS.find((group) => group.items.includes(currentDestination.value)));
watch(menuOpen, async (open) => {
  const restoreFocus = !open && menuDrawer.value?.contains(document.activeElement);
  await nextTick();
  if (open) menuDrawer.value?.querySelector('button')?.focus();
  else if (restoreFocus) menuButton.value?.focus();
});
const liveCount = computed(() => jobs.activeCount + devices.connectionCount);

// Picking a destination is the end of the menu's job.
watch(() => route.fullPath, () => (menuOpen.value = false));

function onKeydown(event) {
  if (!menuOpen.value) return;
  if (event.key === 'Escape') {
    menuOpen.value = false;
    menuButton.value?.focus();
  }
  if (event.key === 'Tab') {
    const controls = menuDrawer.value?.querySelectorAll('a, button');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
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
      ref="menuButton"
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
    <nav class="topbar-sections" aria-label="App sections">
      <RouterLink
        v-for="group in primaryGroups"
        :key="group.key"
        :to="group.items[0].to"
        active-class=""
        :class="{ current: currentGroup?.key === group.key }"
        :aria-current="currentGroup?.key === group.key ? 'location' : undefined"
      >
        {{ group.label }}
      </RouterLink>
    </nav>
  </header>

  <div v-if="menuOpen" class="nav-scrim" data-test="nav-scrim" @click="menuOpen = false"></div>

  <nav
    v-if="auth.isLoggedIn"
    id="main-nav"
    ref="menuDrawer"
    aria-label="Main navigation"
    :inert="!menuOpen"
    class="nav-drawer"
    :class="{ open: menuOpen }"
    :aria-hidden="menuOpen ? 'false' : 'true'"
  >
    <div class="nav-drawer-title">
      <strong>Navigation</strong>
      <button type="button" class="secondary" aria-label="Close menu" @click="menuOpen = false">×</button>
    </div>
    <section
      v-for="group in visibleGroups"
      :key="group.key"
      :aria-labelledby="`nav-heading-${group.key}`"
      :data-test="`nav-section-${group.key}`"
    >
      <p :id="`nav-heading-${group.key}`" class="nav-heading">{{ group.label }}</p>
      <RouterLink
        v-for="item in group.items"
        :key="item.to"
        :to="item.to"
        active-class=""
        :class="{ 'router-link-active': currentDestination?.to === item.to }"
        :aria-current="currentDestination?.to === item.to ? (route.path === item.to ? 'page' : 'location') : undefined"
        :data-test="item.test || `nav-${item.to.slice(1).replaceAll('/', '-')}`"
        @click="menuOpen = false"
      >
        {{ item.label }}
        <span v-if="item.to === '/devices' && devices.connectionCount > 0" class="badge running">{{ devices.connectionCount }}</span>
        <span v-if="item.to === '/jobs' && jobs.activeCount > 0" class="badge running">{{ jobs.activeCount }}</span>
        <span v-if="item.to === '/account/email' && !auth.user.email_verified_at" class="badge pending" data-test="email-unconfirmed">unconfirmed</span>
      </RouterLink>
    </section>

    <div class="nav-foot">
      <span class="nav-user">Signed in as {{ auth.user.username }}</span>
      <a href="#" data-test="logout" @click.prevent="logout">Log out</a>
    </div>
  </nav>

  <main class="container">
    <RecordNavigation v-if="auth.isLoggedIn && detail.kind === 'patch'" />
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
    <!-- Only when an admin has set one (Application Config). -->
    <template v-if="site.discordInviteUrl">
      <span class="sep" aria-hidden="true">·</span>
      <a
        :href="site.discordInviteUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-test="discord-link"
      >
        Discord
      </a>
    </template>
  </footer>
</template>
