import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

// The socket is a black box here: the shell only opens it, feeds its events
// to the stores and closes it again.
vi.mock('../src/progressSocket.js', () => ({
  createProgressSocket: vi.fn(() => ({ close: vi.fn() })),
}));

const routerPush = vi.fn();
const route = reactive({ fullPath: '/modules', query: {} });
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => route,
  };
});

import { api } from '../src/api.js';
import { createProgressSocket } from '../src/progressSocket.js';
import App from '../src/App.vue';
import { useAuthStore } from '../src/stores/auth.js';
import { useJobsStore } from '../src/stores/jobs.js';
import { useDevicesStore } from '../src/stores/devices.js';
import { useDetailStore } from '../src/stores/detail.js';

beforeEach(() => {
  vi.clearAllMocks();
  route.fullPath = '/modules';
});

// The app shell needs a live pinia before mounting so the session can be
// planted in the auth store first.
function mountApp(user = { id: 1, username: 'nick', is_admin: false }) {
  const global = testGlobal();
  const auth = useAuthStore();
  auth.user = user;
  auth.loaded = true;
  const wrapper = mount(App, { global });
  return {
    wrapper,
    auth,
    jobs: useJobsStore(),
    devices: useDevicesStore(),
    detail: useDetailStore(),
  };
}

describe('App', () => {
  it('opens one progress socket for a logged-in user and closes it on logout', async () => {
    const { wrapper, auth } = mountApp();
    await flushPromises();
    expect(createProgressSocket).toHaveBeenCalledTimes(1);

    auth.user = null;
    await flushPromises();
    expect(createProgressSocket.mock.results[0].value.close).toHaveBeenCalled();
    expect(createProgressSocket).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('does not open a socket, or show the chrome, when nobody is logged in', async () => {
    const { wrapper } = mountApp(null);
    await flushPromises();
    expect(createProgressSocket).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="nav-toggle"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('routes device events to the devices store and job events to the jobs store', async () => {
    const { wrapper, jobs, devices } = mountApp();
    await flushPromises();
    const { onEvent } = createProgressSocket.mock.calls[0][0];

    onEvent({
      kind: 'device',
      event: 'connected',
      device: { id: 3, token_id: 1, name: 'Bench scope' },
    });
    expect(devices.connectionCount).toBe(1);
    expect(jobs.jobs).toHaveLength(0);

    onEvent({
      kind: 'job',
      event: 'started',
      job: { id: 9, type: 'analyze_manual', status: 'running' },
      at: '2026-08-18T10:00:00Z',
    });
    expect(jobs.jobs.map((j) => j.id)).toEqual([9]);
    expect(jobs.activeCount).toBe(1);
    wrapper.unmount();
  });

  // The feed carries CHANGES, so a socket that has just come up knows nothing
  // about the scope that was already connected — or about one that went while
  // it was down. The shell reads the device list on every open.
  it('reads the connected scopes whenever the socket comes up', async () => {
    const { wrapper, devices } = mountApp();
    await flushPromises();
    api.get.mockResolvedValue([{ id: 1, connections: [{ id: 3, token_id: 1, name: 'Bench' }] }]);

    const { onOpen } = createProgressSocket.mock.calls[0][0];
    onOpen();
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/api/devices', { quiet: true });
    expect(devices.connectionCount).toBe(1);
    wrapper.unmount();
  });

  it('opens the drawer from the hamburger and closes it on Escape or navigation', async () => {
    const { wrapper } = mountApp();
    await flushPromises();
    const toggle = wrapper.find('[data-test="nav-toggle"]');
    const drawer = () => wrapper.find('#main-nav');
    expect(drawer().classes()).not.toContain('open');

    await toggle.trigger('click');
    expect(drawer().classes()).toContain('open');
    expect(toggle.attributes('aria-expanded')).toBe('true');

    // Escape is heard on the window, not on any one element.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(drawer().classes()).not.toContain('open');

    // Picking a destination is the end of the menu's job.
    await toggle.trigger('click');
    expect(drawer().classes()).toContain('open');
    route.fullPath = '/patches';
    await nextTick();
    expect(drawer().classes()).not.toContain('open');

    // The scrim behind the drawer also closes it.
    await toggle.trigger('click');
    await wrapper.find('[data-test="nav-scrim"]').trigger('click');
    expect(drawer().classes()).not.toContain('open');
    wrapper.unmount();
  });

  it('rides the live count on the closed hamburger', async () => {
    const { wrapper, jobs, devices } = mountApp();
    await flushPromises();
    expect(wrapper.find('[data-test="nav-dot"]').exists()).toBe(false);

    jobs.jobs = [{ id: 9, status: 'running' }, { id: 10, status: 'complete' }];
    devices.connections = [{ id: 3, token_id: 1 }];
    await nextTick();
    expect(wrapper.find('[data-test="nav-dot"]').text()).toBe('2');

    // Open, the drawer shows its own badges, so the dot steps aside.
    await wrapper.find('[data-test="nav-toggle"]').trigger('click');
    expect(wrapper.find('[data-test="nav-dot"]').exists()).toBe(false);
    wrapper.unmount();
  });

  // A module and a patch are each a dozen routes over one record, so the
  // drawer answers with that record's own pages while one of them is open.
  it('offers the open module’s pages at the top of the drawer', async () => {
    const { wrapper, detail } = mountApp();
    await flushPromises();
    expect(wrapper.find('[data-test="nav-detail-heading"]').exists()).toBe(false);

    const claim = detail.set('module', '4', 'Make Noise Maths');
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-heading"]').text()).toBe('Make Noise Maths');
    expect(wrapper.find('[data-test="nav-detail-index"]').attributes('to')).toBe('/modules/4');
    expect(wrapper.find('[data-test="nav-detail-components"]').attributes('to')).toBe(
      '/modules/4/components'
    );
    expect(wrapper.find('[data-test="nav-detail-bridges"]').text()).toBe('Dual panels');
    // Of the ten component types only the jacks are drawer entries; the rest
    // are one press away on the chip row every component page carries.
    expect(wrapper.find('[data-test="nav-detail-jacks/input"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="nav-detail-parts/knob"]').exists()).toBe(false);
    // The pages come grouped, which is also what keeps the two kinds of
    // switch apart: one under the panel heading, one under signal behavior.
    expect(wrapper.find('[data-test="nav-group-panel"]').text()).toBe('On the panel');
    expect(wrapper.find('[data-test="nav-group-signal"]').text()).toBe('Signal behavior');
    // No counts reported means nothing is badged and nothing is folded.
    expect(wrapper.find('.nav-count').exists()).toBe(false);
    expect(wrapper.find('[data-test="nav-empty-panel"]').exists()).toBe(false);
    // A patch's pages are not on offer while a module is open.
    expect(wrapper.find('[data-test="nav-detail-cables"]').exists()).toBe(false);

    // The rack the reader came from rides along, so previous/next keeps
    // walking that rack from whichever page they are on.
    route.query = { rack: '2' };
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-videos"]').attributes('to')).toBe(
      '/modules/4/videos?rack=2'
    );

    // A route swap mounts the arriving header before the departing one lets
    // go, so a header only ever gives up the claim it was granted.
    detail.set('module', '5', 'Mutable Rings');
    detail.clear(claim);
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-heading"]').text()).toBe('Mutable Rings');

    detail.clear(detail.claim);
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-heading"]').exists()).toBe(false);
    route.query = {};
    wrapper.unmount();
  });

  it('offers the open patch’s pages instead, when a patch is what is open', async () => {
    const { wrapper, detail } = mountApp();
    await flushPromises();

    detail.set('patch', '7', 'Krell');
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-heading"]').text()).toBe('Krell');
    expect(wrapper.find('[data-test="nav-detail-index"]').attributes('to')).toBe('/patches/7');
    expect(wrapper.find('[data-test="nav-detail-cables"]').attributes('to')).toBe(
      '/patches/7/cables'
    );
    expect(wrapper.find('[data-test="nav-detail-scope"]').text()).toBe('Oscilloscope');
    expect(wrapper.find('[data-test="nav-group-patch"]').text()).toBe('Connections & setup');
    // A patch has no rack query to carry.
    route.query = { rack: '2' };
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-notes"]').attributes('to')).toBe(
      '/patches/7/notes'
    );
    route.query = {};
    wrapper.unmount();
  });

  // The header reports how many rows each page has, and the drawer answers
  // with a count beside the full pages and the empty ones folded behind one
  // line per group — a module is twenty-seven pages and for most modules
  // half of them are blank.
  it('badges the full pages and folds the empty ones away', async () => {
    const { wrapper, detail } = mountApp();
    await flushPromises();

    detail.set('module', '4', 'Make Noise Maths', {
      components: 6,
      input_jack: 2,
      output_jack: 2,
      values: 3,
      parameters: 0,
      normalizations: 1,
      routing_switches: 0,
      routes: 2,
      pairs: 0,
      expanders: 0,
      bridges: 0,
      documents: 1,
      videos: 0,
      notes: 0,
    });
    await nextTick();

    // A page with rows carries its count beside its name…
    const outputs = wrapper.find('[data-test="nav-detail-jacks/output"]');
    expect(outputs.text()).toContain('Output jacks');
    expect(outputs.find('.nav-count').text()).toBe('2');

    // …a page with none is folded behind the group's one line…
    expect(wrapper.find('[data-test="nav-detail-parameters"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="nav-detail-pairs"]').exists()).toBe(false);
    // The jack page the counts never mentioned counts as unknown, not empty.
    expect(wrapper.find('[data-test="nav-detail-jacks/bidirectional"]').exists()).toBe(true);
    const fold = wrapper.find('[data-test="nav-empty-panel"]');
    expect(fold.text()).toBe('Empty pages (1)');
    await fold.trigger('click');
    expect(wrapper.find('[data-test="nav-detail-parameters"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="nav-empty-panel"]').text()).toBe('Hide empty pages');
    expect(wrapper.find('[data-test="nav-empty-signal"]').text()).toBe('Empty pages (4)');

    // …and a page whose rows are not in the payload is neither badged nor
    // folded: absent means unknown, not empty.
    const audio = wrapper.find('[data-test="nav-detail-audio"]');
    expect(audio.exists()).toBe(true);
    expect(audio.find('.nav-count').exists()).toBe(false);

    // The page the reader is ON is never folded, empty or not.
    route.path = '/modules/4/pairs';
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-pairs"]').exists()).toBe(true);
    route.path = undefined;
    wrapper.unmount();
  });

  // The record's name is also the fold for its whole block of pages, so the
  // rest of the app is one tap away instead of a scroll past thirty links.
  it('folds the whole record block behind its heading, and opens it for the next record', async () => {
    const { wrapper, detail } = mountApp();
    await flushPromises();

    detail.set('module', '4', 'Make Noise Maths');
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-index"]').exists()).toBe(true);

    await wrapper.find('[data-test="nav-detail-heading"]').trigger('click');
    expect(wrapper.find('[data-test="nav-detail-index"]').exists()).toBe(false);
    // The heading itself, and the rest of the app, stay where they were.
    expect(wrapper.find('[data-test="nav-detail-heading"]').text()).toBe('Make Noise Maths');
    expect(wrapper.text()).toContain('Your system');

    await wrapper.find('[data-test="nav-detail-heading"]').trigger('click');
    expect(wrapper.find('[data-test="nav-detail-index"]').exists()).toBe(true);

    // Folding is a way of reading this record's drawer, not a setting: the
    // next record opens open.
    await wrapper.find('[data-test="nav-detail-heading"]').trigger('click');
    detail.set('patch', '7', 'Krell');
    await nextTick();
    expect(wrapper.find('[data-test="nav-detail-index"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('logs out through the drawer and lands on the login page', async () => {
    api.post.mockResolvedValue({ ok: true });
    const { wrapper, auth } = mountApp();
    await flushPromises();

    await wrapper.find('[data-test="nav-toggle"]').trigger('click');
    await wrapper.find('[data-test="logout"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/logout');
    expect(auth.user).toBe(null);
    expect(routerPush).toHaveBeenCalledWith({ name: 'login' });
    // The socket does not outlive the session.
    expect(createProgressSocket.mock.results[0].value.close).toHaveBeenCalled();
    wrapper.unmount();
  });

  // The admin pages are guarded on the server and again by the router; the
  // drawer is the third place the same rule has to hold, because a link to a
  // page that answers 403 is worse than no link at all.
  it('lists the admin pages for an admin and for nobody else', async () => {
    const plain = mountApp();
    await flushPromises();
    expect(plain.wrapper.find('[data-test="nav-csp-reports"]').exists()).toBe(false);
    expect(plain.wrapper.text()).not.toContain('Application Config');
    plain.wrapper.unmount();

    const admin = mountApp({ id: 2, username: 'root', is_admin: true });
    await flushPromises();
    expect(admin.wrapper.text()).toContain('Users');
    expect(admin.wrapper.text()).toContain('Application Config');
    // Where the browser's own refusals are read (nginx/csp.conf,
    // server/src/routes/cspReports.js).
    expect(admin.wrapper.find('[data-test="nav-csp-reports"]').exists()).toBe(true);
    admin.wrapper.unmount();
  });
});
