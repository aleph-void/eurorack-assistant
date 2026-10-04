import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
    useRoute: () => ({ query: currentRouteQuery }),
  };
});

import { api } from '../../src/api.js';
import VerifyEmailView from '../../src/views/VerifyEmailView.vue';
import { useAuthStore } from '../../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('VerifyEmailView', () => {
  it('redeems the token in the link and re-reads the logged-in user', async () => {
    currentRouteQuery = { token: 'a'.repeat(64) };
    api.post.mockResolvedValue({ ok: true, email: 'alice@example.com' });
    api.get.mockResolvedValue({ id: 1, username: 'alice', email: 'alice@example.com', email_verified_at: 'now' });
    const global = testGlobal();
    const auth = useAuthStore();
    auth.user = { id: 1, username: 'alice', email: 'alice@example.com', email_verified_at: null };
    const wrapper = mount(VerifyEmailView, { global });
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/verify-email', { token: 'a'.repeat(64) }, { quiet: true });
    expect(wrapper.find('[data-test="confirmed"]').text()).toContain('alice@example.com');
    expect(api.get).toHaveBeenCalledWith('/api/auth/me', { quiet: true });
    expect(auth.user.email_verified_at).toBe('now');
  });

  it('shows why a link did not work', async () => {
    currentRouteQuery = {};
    api.post.mockRejectedValue(new Error('This confirmation link is not valid or has expired'));
    const wrapper = mount(VerifyEmailView, { global: testGlobal() });
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/verify-email', { token: '' }, { quiet: true });
    expect(wrapper.find('[data-test="error"]').text()).toContain('not valid');
    expect(api.get).not.toHaveBeenCalled();
  });
});
