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
import { useAuthStore } from '../../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('UsersView', () => {
  it('creates a user with an address and reveals the generated password once', async () => {
    api.get.mockResolvedValue([{ id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() }]);
    api.post.mockResolvedValue({
      id: 2,
      username: 'newbie',
      email: 'newbie@example.com',
      is_admin: false,
      generated_password: 'abc123xyz',
      verification: { sent: true, problem: null },
    });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="username"]').setValue('newbie');
    await wrapper.find('[data-test="email"]').setValue(' Newbie@example.com ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users', { username: 'newbie', email: 'Newbie@example.com' });
    expect(wrapper.find('[data-test="generated-password"]').text()).toBe('abc123xyz');
    expect(wrapper.find('[data-test="created-verification"]').text()).toContain('mailed to newbie@example.com');
    expect(wrapper.find('[data-test="email"]').element.value).toBe('');
  });

  it('says so when the confirmation mail for a new user did not go', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({
      id: 2,
      username: 'newbie',
      email: 'newbie@example.com',
      is_admin: false,
      verification: { sent: false, problem: 'Mail is not set up: the SMTP host is not set' },
    });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="username"]').setValue('newbie');
    await wrapper.find('[data-test="email"]').setValue('newbie@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="created-verification"]').text()).toContain('SMTP host is not set');
  });

  it('shows each address with whether it is confirmed, and lets the admin change one', async () => {
    const users = [
      { id: 1, username: 'admin', is_admin: true, email: 'admin@example.com', email_verified_at: '2026-01-01T00:00:00Z', created_at: new Date().toISOString(), last_login_at: '2026-03-04T05:06:07Z' },
      { id: 2, username: 'alice', is_admin: false, email: 'alice@example.com', email_verified_at: null, created_at: new Date().toISOString(), last_login_at: null },
    ];
    api.get.mockResolvedValue(users);
    api.put.mockResolvedValue({
      ...users[1],
      email: 'alice@example.net',
      verification: { sent: true, problem: null },
    });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="email-state-1"]').text()).toBe('confirmed');
    expect(wrapper.find('[data-test="email-state-2"]').text()).toBe('unconfirmed');
    expect(wrapper.find('[data-test="email-2"]').text()).toContain('alice@example.com');
    expect(wrapper.find('[data-test="last-login-1"]').text()).toBe(new Date('2026-03-04T05:06:07Z').toLocaleString());
    expect(wrapper.find('[data-test="last-login-2"]').text()).toBe('never');

    await wrapper.find('[data-test="edit-email-2"]').trigger('click');
    const input = wrapper.find('[data-test="email-input-2"]');
    expect(input.element.value).toBe('alice@example.com');
    await input.setValue(' alice@example.net ');
    await wrapper.find('[data-test="save-email-2"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/users/2/email', { email: 'alice@example.net' });
    expect(wrapper.find('[data-test="email-result"]').text()).toContain('alice@example.net');
    expect(wrapper.find('[data-test="email-result"]').text()).toContain('mailed');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/users')).toHaveLength(2);
  });

  it('locks an account once the admin confirms, and unlocks a locked one', async () => {
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, email: 'a@example.com', created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, email: 'b@example.com', created_at: new Date().toISOString() },
      {
        id: 3,
        username: 'bob',
        is_admin: false,
        email: 'c@example.com',
        created_at: new Date().toISOString(),
        locked_at: '2026-01-01T00:00:00Z',
        locked_reason: 'failed_logins',
      },
    ]);
    api.put.mockResolvedValue({});
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const global = testGlobal();
    useAuthStore().user = { id: 1, username: 'admin', is_admin: true };
    const wrapper = mount(UsersView, { global });
    await flushPromises();
    // The admin's own row offers neither.
    expect(wrapper.find('[data-test="lock-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="locked-3"]').text()).toContain('failed logins');
    expect(wrapper.find('[data-test="lock-3"]').exists()).toBe(false);

    await wrapper.find('[data-test="lock-2"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Lock account', danger: true }));
    expect(api.put).toHaveBeenCalledWith('/api/users/2/lock', { locked: true });

    await wrapper.find('[data-test="unlock-3"]').trigger('click');
    await flushPromises();
    // Unlocking asks nothing.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/api/users/3/lock', { locked: false });
    vi.restoreAllMocks();
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

  // The transfer panel: pick whose system, which one, who gets it; the
  // confirm says what goes; the result says what went.
  describe('transferring a system', () => {
    const users = [
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
      { id: 3, username: 'bob', is_admin: false, created_at: new Date().toISOString() },
    ];
    const systems = [{ id: 7, name: 'studio', rack_count: 2, module_count: 9, patch_count: 3 }];
    const answer = (path) => {
      if (path === '/api/users') return Promise.resolve(users);
      if (path === '/api/users/2/systems') return Promise.resolve(systems);
      if (path === '/api/usage') return Promise.resolve(null);
      return Promise.resolve([]);
    };

    it('lists the picked owner\'s systems and leaves them out of the recipients', async () => {
      api.get.mockImplementation(answer);
      const wrapper = mount(UsersView, { global: testGlobal() });
      await flushPromises();
      expect(wrapper.find('[data-test="transfer"]').attributes('disabled')).toBeDefined();
      await wrapper.find('[data-test="transfer-owner"]').setValue('2');
      await flushPromises();
      expect(api.get).toHaveBeenCalledWith('/api/users/2/systems');
      const options = wrapper.findAll('[data-test="transfer-system"] option').map((o) => o.text());
      expect(options.some((text) => text.includes('studio') && text.includes('9 modules'))).toBe(true);
      const recipients = wrapper.findAll('[data-test="transfer-to"] option').map((o) => o.text());
      expect(recipients).toContain('bob');
      expect(recipients).not.toContain('alice');
    });

    it('transfers once the admin confirms, then reports what moved', async () => {
      api.get.mockImplementation(answer);
      const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
      api.post.mockResolvedValue({
        ok: true,
        system: { id: 7, name: 'studio 2' },
        from: { id: 2, username: 'alice' },
        to: { id: 3, username: 'bob' },
        moved: { racks: 2, modules: 9, patches: 3, questions: 4, notes: 0, shares: 0, jobs: 0 },
        kept_modules: 0,
        renamed: [{ kind: 'system', id: 7, from: 'studio', to: 'studio 2' }],
      });
      const wrapper = mount(UsersView, { global: testGlobal() });
      await flushPromises();
      await wrapper.find('[data-test="transfer-owner"]').setValue('2');
      await flushPromises();
      await wrapper.find('[data-test="transfer-system"]').setValue('7');
      await wrapper.find('[data-test="transfer-to"]').setValue('3');
      await wrapper.find('[data-test="transfer"]').trigger('click');
      await flushPromises();
      expect(confirm).toHaveBeenCalled();
      expect(confirm.mock.calls[0][0].message).toContain('from alice to bob');
      expect(api.post).toHaveBeenCalledWith('/api/systems/7/transfer', { user_id: 3 });
      const result = wrapper.find('[data-test="transfer-result"]');
      expect(result.text()).toContain('studio 2');
      expect(result.text()).toContain('bob');
      expect(wrapper.find('[data-test="transfer-moved"]').text()).toContain('2 racks, 9 modules, 3 patches, 4 questions');
      expect(wrapper.find('[data-test="transfer-renamed"]').text()).toContain("'studio' → 'studio 2'");
      vi.restoreAllMocks();
    });

    it('does nothing when the admin backs out', async () => {
      api.get.mockImplementation(answer);
      vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
      const wrapper = mount(UsersView, { global: testGlobal() });
      await flushPromises();
      await wrapper.find('[data-test="transfer-owner"]').setValue('2');
      await flushPromises();
      await wrapper.find('[data-test="transfer-system"]').setValue('7');
      await wrapper.find('[data-test="transfer-to"]').setValue('3');
      await wrapper.find('[data-test="transfer"]').trigger('click');
      await flushPromises();
      expect(api.post).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });
});
