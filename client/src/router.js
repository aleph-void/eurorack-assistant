import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
// EVERY VIEW IS ITS OWN CHUNK. Importing them all here put the whole app —
// the voice stack, the markdown renderer and its sanitizer, the scope, the
// admin pages — into one file that everybody downloaded to look at their
// module list: 567 kB of JavaScript against 134 kB split, and the CSS with
// it. LoginView is the exception, because it is the first thing an unknown
// visitor is shown and a second round trip to find out they must log in is a
// second round trip.
import LoginView from './views/LoginView.vue';
const ModulesView = () => import('./views/ModulesView.vue');
const ModuleDetailView = () => import('./views/ModuleDetailView.vue');
const ModuleComponentsView = () => import('./views/ModuleComponentsView.vue');
const ModuleComponentTypeView = () => import('./views/ModuleComponentTypeView.vue');
const ModuleValuesView = () => import('./views/ModuleValuesView.vue');
const ModuleParametersView = () => import('./views/ModuleParametersView.vue');
const ModuleNormalizationsView = () => import('./views/ModuleNormalizationsView.vue');
const ModuleSwitchesView = () => import('./views/ModuleSwitchesView.vue');
const ModuleRoutesView = () => import('./views/ModuleRoutesView.vue');
const ModulePairsView = () => import('./views/ModulePairsView.vue');
const ModuleExpandersView = () => import('./views/ModuleExpandersView.vue');
const ModuleBridgesView = () => import('./views/ModuleBridgesView.vue');
const ModuleDocumentsView = () => import('./views/ModuleDocumentsView.vue');
const ModuleVideosView = () => import('./views/ModuleVideosView.vue');
const ModuleNotesView = () => import('./views/ModuleNotesView.vue');
const ModuleQuestionsView = () => import('./views/ModuleQuestionsView.vue');
const RacksView = () => import('./views/RacksView.vue');
const SystemsView = () => import('./views/SystemsView.vue');
const PatchesView = () => import('./views/PatchesView.vue');
const PatchDetailView = () => import('./views/PatchDetailView.vue');
const PatchCablesView = () => import('./views/PatchCablesView.vue');
const PatchSettingsView = () => import('./views/PatchSettingsView.vue');
const PatchFlowView = () => import('./views/PatchFlowView.vue');
const PatchLinksView = () => import('./views/PatchLinksView.vue');
const PatchScopeView = () => import('./views/PatchScopeView.vue');
const PatchNotesView = () => import('./views/PatchNotesView.vue');
const PatchModulesView = () => import('./views/PatchModulesView.vue');
const PatchQuestionsView = () => import('./views/PatchQuestionsView.vue');
const ImportView = () => import('./views/ImportView.vue');
const SearchView = () => import('./views/SearchView.vue');
const ManualTextView = () => import('./views/ManualTextView.vue');
const AskView = () => import('./views/AskView.vue');
const QuestionsView = () => import('./views/QuestionsView.vue');
const QuestionDetailView = () => import('./views/QuestionDetailView.vue');
const JobsView = () => import('./views/JobsView.vue');
const NotesView = () => import('./views/NotesView.vue');
const SharedView = () => import('./views/SharedView.vue');
const SharedItemView = () => import('./views/SharedItemView.vue');
const DevicesView = () => import('./views/DevicesView.vue');
const LinkDeviceView = () => import('./views/LinkDeviceView.vue');
const UsersView = () => import('./views/UsersView.vue');
const ConfigView = () => import('./views/ConfigView.vue');
const CspReportsView = () => import('./views/CspReportsView.vue');
const ChangePasswordView = () => import('./views/ChangePasswordView.vue');
const LlmSettingsView = () => import('./views/LlmSettingsView.vue');
const VoiceSettingsView = () => import('./views/VoiceSettingsView.vue');

export const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', redirect: '/modules' },
  { path: '/account/password', name: 'change-password', component: ChangePasswordView },
  // Per-user LLM provider account and settings.
  { path: '/account/llm', name: 'llm-settings', component: LlmSettingsView },
  // Patching by voice is a way of WORKING, not a property of a patch: it is
  // set up once, here, and listens over whatever patch diagram is open.
  { path: '/account/voice', name: 'voice-settings', component: VoiceSettingsView },
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
  // Every kind of thing on the panel is a page of its own — with the front
  // plate on it, because where a component SITS on the picture is the fact
  // the whole patch diagram is built out of. Jacks keep their own path
  // because a jack is what a cable goes in and the three kinds are named for
  // that; the controls are addressed by their type.
  {
    path: '/modules/:id/jacks/:kind(input|output|bidirectional)',
    name: 'module-jacks',
    component: ModuleComponentTypeView,
    props: (to) => ({ id: to.params.id, type: `${to.params.kind}_jack` }),
  },
  {
    path: '/modules/:id/parts/:type(knob|slider|button|toggle|switch|display|other)',
    name: 'module-parts',
    component: ModuleComponentTypeView,
    props: true,
  },
  { path: '/modules/:id/values', name: 'module-values', component: ModuleValuesView, props: true },
  // The settings the module keeps in a MENU rather than under a control of
  // its own — a menu-driven module's whole personality, and nowhere else to
  // record it.
  {
    path: '/modules/:id/parameters',
    name: 'module-parameters',
    component: ModuleParametersView,
    props: true,
  },
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
  // Asking the assistant about THIS module: the questions already asked about
  // it, and the box that asks the next one with it already in scope.
  {
    path: '/modules/:id/questions',
    name: 'module-questions',
    component: ModuleQuestionsView,
    props: true,
  },
  { path: '/racks', name: 'racks', component: RacksView },
  { path: '/systems', name: 'systems', component: SystemsView },
  { path: '/patches', name: 'patches', component: PatchesView },
  // A patch is likewise a page per thing: the detail page is the picture of
  // the case and the two-jack drag that patches a cable on it, and everything
  // else — the cable list, how the patch is set up, the scope, the notes —
  // is its own route in the nav drawer. Patching by voice is not among them:
  // it is an account setting that listens over whichever diagram is open.
  { path: '/patches/:id', name: 'patch-detail', component: PatchDetailView, props: true },
  { path: '/patches/:id/cables', name: 'patch-cables', component: PatchCablesView, props: true },
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
  // The same for a patch — and asking from here attaches the patch, which is
  // what makes the answer about these cables and these settings.
  {
    path: '/patches/:id/questions',
    name: 'patch-questions',
    component: PatchQuestionsView,
    props: true,
  },
  // Where the one page that held all of the above used to be.
  { path: '/patches/:id/config', redirect: (to) => `/patches/${to.params.id}/settings` },
  // Voice patching used to be a page of each patch. It is an account setting
  // now, and the patch it works on is whichever one is on screen.
  { path: '/patches/:id/voice', redirect: '/account/voice' },
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
  // What browsers refused to load, reported by the browsers themselves. The
  // policy is nginx/csp.conf and server/src/csp.js; this is its other end.
  {
    path: '/admin/csp-reports',
    name: 'csp-reports',
    component: CspReportsView,
    meta: { admin: true },
  },
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
