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
import { dialog } from '../../src/dialog.js';
import UsersView from '../../src/views/UsersView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('UsersView', () => {
  it('creates a user and reveals the generated password once', async () => {
    api.get.mockResolvedValue([{ id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() }]);
    api.post.mockResolvedValue({
      id: 2,
      username: 'newbie',
      is_admin: false,
      generated_password: 'abc123xyz',
    });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="username"]').setValue('newbie');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users', { username: 'newbie' });
    expect(wrapper.find('[data-test="generated-password"]').text()).toBe('abc123xyz');
  });

  it('resets a user password and reveals the generated password once', async () => {
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    api.post.mockResolvedValue({ ok: true, username: 'alice', generated_password: 'freshpw123' });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="reset-2"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users/2/password');
    expect(wrapper.find('[data-test="reset-password-value"]').text()).toBe('freshpw123');
    vi.restoreAllMocks();
  });

  it('lists users with roles', async () => {
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    const text = wrapper.find('[data-test="user-table"]').text();
    expect(text).toContain('admin');
    expect(text).toContain('alice');
  });

  it('deletes a user once the admin confirms, then reloads the list', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete user', danger: true })
    );
    expect(api.delete).toHaveBeenCalledWith('/api/users/2');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/users')).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('leaves the user alone when the confirm is declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([path]) => path === '/api/users')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('shows why a user could not be deleted', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    api.delete.mockRejectedValue(new Error('that user still owns running jobs'));
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('still owns running jobs');
    vi.restoreAllMocks();
  });
});


describe('UsersView budgets', () => {
  const usersResponse = [
    { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString(), token_budget: null },
    { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString(), token_budget: null },
  ];
  const usageResponse = {
    period: 'month',
    default_limit: 1000,
    total_tokens: 1200,
    total_cost_usd: 0,
    users: [
      { id: 1, username: 'admin', used: 0, limit: 0, unlimited: true, exhausted: false },
      { id: 2, username: 'alice', used: 1200, limit: 1000, unlimited: false, exhausted: true },
    ],
  };

  it('shows what each user has spent and marks the ones who are out', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/usage' ? usageResponse : usersResponse)
    );
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="spent-2"]').text()).toContain('1,200');
    expect(wrapper.find('[data-test="exhausted"]').exists()).toBe(true);
    // An admin has no ceiling to set.
    expect(wrapper.find('[data-test="budget-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="usage-window"]').text()).toContain('last 30 days');
  });

  it('sets and clears one user’s allowance', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/usage' ? usageResponse : usersResponse)
    );
    api.put.mockResolvedValue({ id: 2, username: 'alice', token_budget: 5000 });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="budget-2"]').setValue('5000');
    await wrapper.find('[data-test="save-budget-2"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/users/2/budget', { token_budget: 5000 });

    // Blank hands them back the configured default.
    await wrapper.find('[data-test="budget-2"]').setValue('');
    await wrapper.find('[data-test="save-budget-2"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith('/api/users/2/budget', { token_budget: null });
  });
});
