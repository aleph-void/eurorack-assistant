import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import LoginView from './views/LoginView.vue';
import ModulesView from './views/ModulesView.vue';
import ModuleDetailView from './views/ModuleDetailView.vue';
import ModuleComponentsView from './views/ModuleComponentsView.vue';
import ModuleValuesView from './views/ModuleValuesView.vue';
import ModuleNormalizationsView from './views/ModuleNormalizationsView.vue';
import ModuleSwitchesView from './views/ModuleSwitchesView.vue';
import ModuleRoutesView from './views/ModuleRoutesView.vue';
import ModulePairsView from './views/ModulePairsView.vue';
import ModuleExpandersView from './views/ModuleExpandersView.vue';
import ModuleBridgesView from './views/ModuleBridgesView.vue';
import ModuleDocumentsView from './views/ModuleDocumentsView.vue';
import ModuleVideosView from './views/ModuleVideosView.vue';
import ModuleNotesView from './views/ModuleNotesView.vue';
import RacksView from './views/RacksView.vue';
import SystemsView from './views/SystemsView.vue';
import PatchesView from './views/PatchesView.vue';
import PatchDetailView from './views/PatchDetailView.vue';
import PatchCablesView from './views/PatchCablesView.vue';
import PatchVoiceView from './views/PatchVoiceView.vue';
import PatchSettingsView from './views/PatchSettingsView.vue';
import PatchFlowView from './views/PatchFlowView.vue';
import PatchLinksView from './views/PatchLinksView.vue';
import PatchScopeView from './views/PatchScopeView.vue';
import PatchNotesView from './views/PatchNotesView.vue';
import PatchModulesView from './views/PatchModulesView.vue';
import ImportView from './views/ImportView.vue';
import SearchView from './views/SearchView.vue';
import ManualTextView from './views/ManualTextView.vue';
import AskView from './views/AskView.vue';
import QuestionsView from './views/QuestionsView.vue';
import QuestionDetailView from './views/QuestionDetailView.vue';
import JobsView from './views/JobsView.vue';
import NotesView from './views/NotesView.vue';
import SharedView from './views/SharedView.vue';
import SharedItemView from './views/SharedItemView.vue';
import DevicesView from './views/DevicesView.vue';
import LinkDeviceView from './views/LinkDeviceView.vue';
import UsersView from './views/UsersView.vue';
import ConfigView from './views/ConfigView.vue';
import ChangePasswordView from './views/ChangePasswordView.vue';
import LlmSettingsView from './views/LlmSettingsView.vue';

export const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', redirect: '/modules' },
  { path: '/account/password', name: 'change-password', component: ChangePasswordView },
  // Per-user LLM provider account and settings.
  { path: '/account/llm', name: 'llm-settings', component: LlmSettingsView },
  { path: '/modules', name: 'modules', component: ModulesView },
  // A module is a page per thing there is to know about it. The detail page
  // itself is the front plate and what the manual says the module is;
  // everything else is its own route, offered in the nav drawer while any of
  // them is open. Each reads the same GET /api/modules/:id.
  { path: '/modules/:id', name: 'module-detail', component: ModuleDetailView, props: true },
  {
    path: '/modules/:id/components',
    name: 'module-components',
    component: ModuleComponentsView,
    props: true,
  },
  { path: '/modules/:id/values', name: 'module-values', component: ModuleValuesView, props: true },
  {
    path: '/modules/:id/normalizations',
    name: 'module-normalizations',
    component: ModuleNormalizationsView,
    props: true,
  },
  {
    path: '/modules/:id/switches',
    name: 'module-switches',
    component: ModuleSwitchesView,
    props: true,
  },
  { path: '/modules/:id/routes', name: 'module-routes', component: ModuleRoutesView, props: true },
  { path: '/modules/:id/pairs', name: 'module-pairs', component: ModulePairsView, props: true },
  {
    path: '/modules/:id/expanders',
    name: 'module-expanders',
    component: ModuleExpandersView,
    props: true,
  },
  {
    path: '/modules/:id/bridges',
    name: 'module-bridges',
    component: ModuleBridgesView,
    props: true,
  },
  {
    path: '/modules/:id/documents',
    name: 'module-documents',
    component: ModuleDocumentsView,
    props: true,
  },
  { path: '/modules/:id/videos', name: 'module-videos', component: ModuleVideosView, props: true },
  { path: '/modules/:id/notes', name: 'module-notes', component: ModuleNotesView, props: true },
  { path: '/racks', name: 'racks', component: RacksView },
  { path: '/systems', name: 'systems', component: SystemsView },
  { path: '/patches', name: 'patches', component: PatchesView },
  // A patch is likewise a page per thing: the detail page is the picture of
  // the case and the two-jack drag that patches a cable on it, and everything
  // else — the cable list, the voice panel, how the patch is set up, the
  // scope, the notes — is its own route in the nav drawer.
  { path: '/patches/:id', name: 'patch-detail', component: PatchDetailView, props: true },
  { path: '/patches/:id/cables', name: 'patch-cables', component: PatchCablesView, props: true },
  { path: '/patches/:id/voice', name: 'patch-voice', component: PatchVoiceView, props: true },
  {
    path: '/patches/:id/settings',
    name: 'patch-settings',
    component: PatchSettingsView,
    props: true,
  },
  { path: '/patches/:id/flow', name: 'patch-flow', component: PatchFlowView, props: true },
  { path: '/patches/:id/links', name: 'patch-links', component: PatchLinksView, props: true },
  { path: '/patches/:id/scope', name: 'patch-scope', component: PatchScopeView, props: true },
  { path: '/patches/:id/notes', name: 'patch-notes', component: PatchNotesView, props: true },
  {
    path: '/patches/:id/modules',
    name: 'patch-modules',
    component: PatchModulesView,
    props: true,
  },
  // Where the one page that held all of the above used to be.
  { path: '/patches/:id/config', redirect: (to) => `/patches/${to.params.id}/settings` },
  { path: '/import', name: 'import', component: ImportView },
  { path: '/search', name: 'search', component: SearchView },
  // A manual read as text, addressed by the document's content hash.
  { path: '/manuals/:hash', name: 'manual-text', component: ManualTextView, props: true },
  { path: '/ask', name: 'ask', component: AskView },
  { path: '/questions', name: 'questions', component: QuestionsView },
  { path: '/questions/:id', name: 'question-detail', component: QuestionDetailView, props: true },
  { path: '/jobs', name: 'jobs', component: JobsView },
  { path: '/notes', name: 'notes', component: NotesView },
  // Sharing has both directions on one page, and a read-only page per record
  // somebody shared with you (documents are read at /manuals/:hash instead).
  { path: '/shared', name: 'shared', component: SharedView },
  { path: '/shared/:type/:id', name: 'shared-item', component: SharedItemView, props: true },
  { path: '/devices', name: 'devices', component: DevicesView },
  // Where a device's verification_uri points; the code may ride along as ?code=
  { path: '/link', name: 'link-device', component: LinkDeviceView },
  { path: '/admin/users', name: 'users', component: UsersView, meta: { admin: true } },
  { path: '/admin/config', name: 'config', component: ConfigView, meta: { admin: true } },
];

// Exported for tests: decides where (if anywhere) to redirect a navigation.
export function guardRedirect(to, { isLoggedIn, isAdmin, mustChangePassword }) {
  if (!to.meta?.public && !isLoggedIn) return { name: 'login', query: { redirect: to.fullPath } };
  // A user with a forced password change can only see the change form.
  if (isLoggedIn && mustChangePassword && to.name !== 'change-password') {
    return { name: 'change-password' };
  }
  if (to.meta?.admin && !isAdmin) return { name: 'modules' };
  if (to.name === 'login' && isLoggedIn) return { name: 'modules' };
  return null;
}

export function createAppRouter() {
  const router = createRouter({
    history: createWebHistory(),
    routes,
  });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    if (!auth.loaded) await auth.fetchMe();
    const redirect = guardRedirect(to, {
      isLoggedIn: auth.isLoggedIn,
      isAdmin: auth.isAdmin,
      mustChangePassword: auth.mustChangePassword,
    });
    return redirect || true;
  });

  return router;
}
