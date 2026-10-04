import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import AccountEmailView from '../../src/views/AccountEmailView.vue';
import { useAuthStore } from '../../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function mountWithUser(user) {
  const global = testGlobal();
  const auth = useAuthStore();
  auth.user = user;
  return { wrapper: mount(AccountEmailView, { global }), auth };
}

const alice = { id: 1, username: 'alice', is_admin: false };

describe('AccountEmailView', () => {
  it('starts from the address on the account and saves a new one with the password', async () => {
    api.put.mockResolvedValue({
      user: { ...alice, email: 'new@example.com', email_verified_at: null },
      verification: { sent: true, problem: null },
    });
    const { wrapper, auth } = mountWithUser({
      ...alice,
      email: 'old@example.com',
      email_verified_at: '2026-01-01T00:00:00Z',
    });
    expect(wrapper.find('[data-test="email"]').element.value).toBe('old@example.com');
    expect(wrapper.find('[data-test="confirmed"]').text()).toContain('old@example.com');

    await wrapper.find('[data-test="email"]').setValue(' New@example.com ');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/auth/email', {
      email: 'New@example.com',
      current_password: 'password123',
    });
    expect(auth.user.email).toBe('new@example.com');
    expect(wrapper.find('[data-test="saved"]').text()).toContain('mailed to new@example.com');
    expect(wrapper.find('[data-test="current-password"]').element.value).toBe('');
    // Not confirmed until the link is followed.
    expect(wrapper.find('[data-test="unconfirmed"]').exists()).toBe(true);
  });

  it('asks for an address when the account carries the placeholder', async () => {
    const { wrapper } = mountWithUser({ ...alice, email: 'alice@unset.invalid', email_verified_at: null });
    expect(wrapper.find('[data-test="needs-address"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="email"]').element.value).toBe('');
    expect(wrapper.find('[data-test="resend"]').exists()).toBe(false);
  });

  it('sends the confirmation again for an unconfirmed address', async () => {
    api.post.mockResolvedValue({ sent: true, problem: null });
    const { wrapper } = mountWithUser({ ...alice, email: 'alice@example.com', email_verified_at: null });
    await wrapper.find('[data-test="resend"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/verify-email/resend');
    expect(wrapper.find('[data-test="resent"]').text()).toContain('Check your inbox');
  });

  it('says when the change was kept but the mail did not go', async () => {
    api.put.mockResolvedValue({
      user: { ...alice, email: 'new@example.com', email_verified_at: null },
      verification: { sent: false, problem: 'Mail is not set up: the SMTP host is not set' },
    });
    const { wrapper } = mountWithUser({ ...alice, email: 'old@example.com', email_verified_at: null });
    await wrapper.find('[data-test="email"]').setValue('new@example.com');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="saved"]').text()).toContain('SMTP host is not set');
  });

  it('shows the API error', async () => {
    api.put.mockRejectedValue(new Error('Email already in use'));
    const { wrapper } = mountWithUser({ ...alice, email: 'alice@example.com', email_verified_at: null });
    await wrapper.find('[data-test="email"]').setValue('taken@example.com');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('already in use');
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(false);
  });
});
