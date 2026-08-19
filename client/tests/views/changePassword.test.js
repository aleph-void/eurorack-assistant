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
import ChangePasswordView from '../../src/views/ChangePasswordView.vue';
import { useAuthStore } from '../../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ChangePasswordView', () => {
  it('changes the password and navigates to modules', async () => {
    api.post.mockResolvedValue({ id: 1, username: 'alice', is_admin: false, must_change_password: false });
    const wrapper = mount(ChangePasswordView, { global: testGlobal() });
    await wrapper.find('[data-test="current-password"]').setValue('old-password');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('new-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/password', {
      current_password: 'old-password',
      new_password: 'new-password',
    });
    expect(routerPush).toHaveBeenCalledWith({ name: 'modules' });
  });

  it('rejects mismatched confirmation without calling the API', async () => {
    const wrapper = mount(ChangePasswordView, { global: testGlobal() });
    await wrapper.find('[data-test="current-password"]').setValue('old-password');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('different');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="error"]').text()).toContain('do not match');
  });

  it('shows the forced-change notice and API errors', async () => {
    api.post.mockRejectedValue(new Error('Current password is incorrect'));
    const global = testGlobal();
    const wrapper = mount(ChangePasswordView, { global });
    const auth = useAuthStore();
    auth.user = { id: 1, username: 'admin', is_admin: true, must_change_password: true };
    await flushPromises();
    expect(wrapper.find('[data-test="forced"]').exists()).toBe(true);

    await wrapper.find('[data-test="current-password"]').setValue('wrong');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('new-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('incorrect');
  });
});
