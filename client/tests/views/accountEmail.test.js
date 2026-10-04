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

describe('AccountEmailView', () => {
  it('starts from the address on the account and saves a new one with the password', async () => {
    api.put.mockResolvedValue({ id: 1, username: 'alice', is_admin: false, email: 'new@example.com' });
    const { wrapper, auth } = mountWithUser({ id: 1, username: 'alice', is_admin: false, email: 'old@example.com' });
    expect(wrapper.find('[data-test="email"]').element.value).toBe('old@example.com');

    await wrapper.find('[data-test="email"]').setValue(' New@example.com ');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/auth/email', {
      email: 'New@example.com',
      current_password: 'password123',
    });
    expect(auth.user.email).toBe('new@example.com');
    expect(wrapper.find('[data-test="saved"]').text()).toContain('new@example.com');
    expect(wrapper.find('[data-test="current-password"]').element.value).toBe('');
  });

  it('sends a blank address to remove it', async () => {
    api.put.mockResolvedValue({ id: 1, username: 'alice', is_admin: false, email: null });
    const { wrapper } = mountWithUser({ id: 1, username: 'alice', is_admin: false, email: 'old@example.com' });
    await wrapper.find('[data-test="email"]').setValue('');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/auth/email', { email: '', current_password: 'password123' });
    expect(wrapper.find('[data-test="saved"]').text()).toContain('removed');
  });

  it('shows the API error', async () => {
    api.put.mockRejectedValue(new Error('Email already in use'));
    const { wrapper } = mountWithUser({ id: 1, username: 'alice', is_admin: false, email: null });
    await wrapper.find('[data-test="email"]').setValue('taken@example.com');
    await wrapper.find('[data-test="current-password"]').setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('already in use');
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(false);
  });
});
