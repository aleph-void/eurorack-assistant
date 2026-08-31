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
    socket = createProgressSocket({ onEvent: dispatch, onOpen: () => devices.reload() });
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
// record's own pages, at the top, above the rest of the app — GROUPED, with
// the count of rows on each page beside its name and the empty pages folded
// behind one line per group, because a module is twenty-seven pages and for
// most modules half of them are blank. `countKey` names the entry in
// detail.counts the header derived from the payload; a page with no
// countKey (or none reported) is neither badged nor folded.
// Every kind of thing on a panel is still a page of its own — the jacks by
// what a cable does at them, the rest by their type — but only the jacks are
// drawer entries: the three kinds a cable goes in are what a patcher opens a
// module for. The rest are one press away on every component page, where a
// chip row (moduledetail/ComponentTypeNav.vue) lists each kind the module
// has, in its own colour, with its count.
const MODULE_PAGES = [
  { path: '', label: 'Front panel & summary', exact: true },
  { path: '/jacks/input', label: 'Input jacks', group: 'panel', countKey: 'input_jack' },
  { path: '/jacks/output', label: 'Output jacks', group: 'panel', countKey: 'output_jack' },
  {
    path: '/jacks/bidirectional',
    label: 'Bidirectional jacks',
    group: 'panel',
    countKey: 'bidirectional_jack',
  },
  { path: '/components', label: 'Controls & components', group: 'panel', countKey: 'components' },
  { path: '/values', label: 'Component values', group: 'panel', countKey: 'values' },
  { path: '/parameters', label: 'Menu parameters', group: 'panel', countKey: 'parameters' },
  {
    path: '/normalizations',
    label: 'Normalled connections',
    group: 'signal',
    countKey: 'normalizations',
  },
  { path: '/switches', label: 'Routing switches', group: 'signal', countKey: 'routing_switches' },
  { path: '/routes', label: 'Internal signal paths', group: 'signal', countKey: 'routes' },
  { path: '/pairs', label: 'Stereo pairs', group: 'signal', countKey: 'pairs' },
  { path: '/expanders', label: 'Expander panels', group: 'signal', countKey: 'expanders' },
  { path: '/bridges', label: 'Dual panels', group: 'signal', countKey: 'bridges' },
  { path: '/documents', label: 'Documents', group: 'reference', countKey: 'documents' },
  { path: '/videos', label: 'Videos', group: 'reference', countKey: 'videos' },
  { path: '/audio', label: 'Recordings', group: 'reference' },
  { path: '/links', label: 'Links', group: 'reference' },
  { path: '/scope', label: 'Oscilloscope', group: 'work' },
  { path: '/notes', label: 'Your notes', group: 'work', countKey: 'notes' },
  { path: '/questions', label: 'Questions', group: 'work' },
];

// The group headings. "Switches" and "Routing switches" stop colliding here:
// one sits under the panel heading with the other controls, the other under
// signal behavior with the rest of what the manual says happens inside.
const MODULE_GROUPS = [
  { key: 'panel', label: 'On the panel' },
  { key: 'signal', label: 'Signal behavior' },
  { key: 'reference', label: 'Reference' },
  { key: 'work', label: 'Your work' },
];

const PATCH_PAGES = [
  { path: '', label: 'Diagram', exact: true },
  { path: '/cables', label: 'Cables', group: 'patch', countKey: 'cables' },
  { path: '/settings', label: 'Control settings', group: 'patch', countKey: 'settings' },
  { path: '/flow', label: 'Signal flow', group: 'patch' },
  { path: '/modules', label: 'Modules in this patch', group: 'patch', countKey: 'modules' },
  { path: '/gear', label: 'Module links, buses & gear', group: 'patch', countKey: 'gear' },
  { path: '/audio', label: 'Recordings', group: 'reference' },
  { path: '/links', label: 'Links', group: 'reference' },
  { path: '/scope', label: 'Oscilloscope', group: 'work' },
  { path: '/notes', label: 'Notes', group: 'work' },
  { path: '/questions', label: 'Questions', group: 'work' },
];

const PATCH_GROUPS = [
  { key: 'patch', label: 'Connections & setup' },
  { key: 'reference', label: 'Reference' },
  { key: 'work', label: 'Your work' },
];

const detailPages = computed(() => (detail.kind === 'patch' ? PATCH_PAGES : MODULE_PAGES));
const detailHeading = computed(() => detail.label || (detail.kind === 'patch' ? 'This patch' : 'This module'));

// The record's front page stands alone under its name; every other page
// stands in its group.
const detailIndexPage = computed(() => detailPages.value.find((page) => page.exact));

// What the header reported for a page: a number, or null for "not known",
// which is how a page whose rows are not in the payload stays visible.
function pageCount(page) {
  if (!page.countKey) return null;
  const count = detail.counts?.[page.countKey];
  return typeof count === 'number' ? count : null;
}

// A page the reader is ON is never folded away, empty or not: hiding the
// link that is lit is how a drawer stops making sense.
const isCurrentPage = (page) => route.path === `${detailBase.value}${page.path}`;

const detailGroups = computed(() => {
  const groups = detail.kind === 'patch' ? PATCH_GROUPS : MODULE_GROUPS;
  return groups
    .map((group) => {
      const members = detailPages.value.filter((page) => page.group === group.key);
      const empty = members.filter((page) => pageCount(page) === 0 && !isCurrentPage(page));
      return { ...group, shown: members.filter((page) => !empty.includes(page)), empty };
    })
    .filter((group) => group.shown.length || group.empty.length);
});

// The folded-away empty pages, opened per group; and the record's whole
// block, folded by its own heading so the rest of the app is one tap away.
// Both start over when the drawer moves to another record.
const emptyOpen = ref({});
const recordOpen = ref(true);
watch(
  () => [detail.kind, detail.id],
  () => {
    emptyOpen.value = {};
    recordOpen.value = true;
  }
);

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
      <button
        class="nav-heading nav-record-toggle"
        type="button"
        :aria-expanded="recordOpen ? 'true' : 'false'"
        data-test="nav-detail-heading"
        @click="recordOpen = !recordOpen"
      >
        {{ detailHeading }}
      </button>
      <template v-if="recordOpen">
        <RouterLink
          :to="detailHref(detailIndexPage)"
          class="nav-sub"
          active-class=""
          data-test="nav-detail-index"
        >
          {{ detailIndexPage.label }}
        </RouterLink>
        <template v-for="group in detailGroups" :key="group.key">
          <p class="nav-subheading" :data-test="`nav-group-${group.key}`">{{ group.label }}</p>
          <RouterLink
            v-for="page in group.shown"
            :key="page.path"
            :to="detailHref(page)"
            class="nav-sub"
            :data-test="`nav-detail-${page.path.slice(1)}`"
          >
            {{ page.label }}
            <span v-if="pageCount(page)" class="nav-count">{{ pageCount(page) }}</span>
          </RouterLink>
          <template v-if="group.empty.length">
            <button
              class="nav-empty-toggle"
              type="button"
              :aria-expanded="emptyOpen[group.key] ? 'true' : 'false'"
              :data-test="`nav-empty-${group.key}`"
              @click="emptyOpen[group.key] = !emptyOpen[group.key]"
            >
              {{ emptyOpen[group.key] ? 'Hide empty pages' : `Empty pages (${group.empty.length})` }}
            </button>
            <template v-if="emptyOpen[group.key]">
              <RouterLink
                v-for="page in group.empty"
                :key="page.path"
                :to="detailHref(page)"
                class="nav-sub nav-empty"
                :data-test="`nav-detail-${page.path.slice(1)}`"
              >
                {{ page.label }}
              </RouterLink>
            </template>
          </template>
        </template>
      </template>
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
