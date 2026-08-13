import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import LoginView from './views/LoginView.vue';
import ModulesView from './views/ModulesView.vue';
import ModuleDetailView from './views/ModuleDetailView.vue';
import RacksView from './views/RacksView.vue';
import PatchesView from './views/PatchesView.vue';
import PatchDetailView from './views/PatchDetailView.vue';
import ImportView from './views/ImportView.vue';
import SearchView from './views/SearchView.vue';
import ManualTextView from './views/ManualTextView.vue';
import AskView from './views/AskView.vue';
import QuestionsView from './views/QuestionsView.vue';
import QuestionDetailView from './views/QuestionDetailView.vue';
import JobsView from './views/JobsView.vue';
import NotesView from './views/NotesView.vue';
import DevicesView from './views/DevicesView.vue';
import LinkDeviceView from './views/LinkDeviceView.vue';
import UsersView from './views/UsersView.vue';
import ConfigView from './views/ConfigView.vue';
import ChangePasswordView from './views/ChangePasswordView.vue';

export const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', redirect: '/modules' },
  { path: '/account/password', name: 'change-password', component: ChangePasswordView },
  { path: '/modules', name: 'modules', component: ModulesView },
  { path: '/modules/:id', name: 'module-detail', component: ModuleDetailView, props: true },
  { path: '/racks', name: 'racks', component: RacksView },
  { path: '/patches', name: 'patches', component: PatchesView },
  { path: '/patches/:id', name: 'patch-detail', component: PatchDetailView, props: true },
  { path: '/import', name: 'import', component: ImportView },
  { path: '/search', name: 'search', component: SearchView },
  // A manual read as text, addressed by the document's content hash.
  { path: '/manuals/:hash', name: 'manual-text', component: ManualTextView, props: true },
  { path: '/ask', name: 'ask', component: AskView },
  { path: '/questions', name: 'questions', component: QuestionsView },
  { path: '/questions/:id', name: 'question-detail', component: QuestionDetailView, props: true },
  { path: '/jobs', name: 'jobs', component: JobsView },
  { path: '/notes', name: 'notes', component: NotesView },
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
