import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => ({ query: currentRouteQuery }),
  };
});

import { api } from '../../src/api.js';
import LoginView from '../../src/views/LoginView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('LoginView', () => {
  it('logs in and navigates to modules', async () => {
    api.post.mockResolvedValue({ id: 1, username: 'alice', is_admin: false });
    const wrapper = mount(LoginView, { global: testGlobal() });
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('pw123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/login', {
      username: 'alice',
      password: 'pw123',
    });
    expect(routerPush).toHaveBeenCalled();
  });

  it('shows a login error', async () => {
    api.post.mockRejectedValue(new Error('Invalid username or password'));
    const wrapper = mount(LoginView, { global: testGlobal() });
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('bad');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Invalid');
  });
});
