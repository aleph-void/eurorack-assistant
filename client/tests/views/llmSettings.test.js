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
import LlmSettingsView from '../../src/views/LlmSettingsView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('LlmSettingsView', () => {
  const llmStatus = (over = {}) => ({
    llm_provider: '',
    llm_model: '',
    llm_models: {},
    llm_job_types: ['find_manual', 'analyze_manual', 'extract_manual'],
    effective_provider: 'claude',
    effective_model: 'claude-fable-5',
    providers: ['claude', 'codex'],
    known_models: { claude: ['claude-fable-5'], codex: ['gpt-5.1'] },
    default_models: { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' },
    accounts: { claude: null, codex: null },
    ...over,
  });
  const claudeAccount = (over = {}) => ({
    provider: 'claude',
    kind: 'oauth',
    connected: true,
    expires_at: null,
    paused_until: null,
    paused_reason: '',
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
    ...over,
  });

  it('warns when no account is connected and walks the authorize flow', async () => {
    api.get.mockResolvedValue(llmStatus());
    const wrapper = mount(LlmSettingsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="not-connected"]').text()).toContain('claude');

    api.post.mockResolvedValueOnce({ url: 'https://claude.ai/oauth/authorize?x=1' });
    await wrapper.find('[data-test="claude-authorize"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/llm/claude/oauth/start');
    expect(wrapper.find('[data-test="claude-auth-link"]').attributes('href')).toContain(
      'claude.ai/oauth/authorize'
    );

    api.post.mockResolvedValueOnce(
      llmStatus({ accounts: { claude: claudeAccount(), codex: null } })
    );
    await wrapper.find('[data-test="claude-auth-code"]').setValue('the-code#state');
    await wrapper.find('[data-test="claude-auth-step"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/llm/claude/oauth/finish', {
      code: 'the-code#state',
    });
    expect(wrapper.find('[data-test="not-connected"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="claude-status"]').text()).toContain('authorized account');
  });

  it('saves the provider and model choice', async () => {
    api.get.mockResolvedValue(llmStatus());
    const wrapper = mount(LlmSettingsView, { global: testGlobal() });
    await flushPromises();

    api.put.mockResolvedValue(
      llmStatus({ llm_provider: 'codex', llm_model: 'gpt-5.1', effective_provider: 'codex' })
    );
    await wrapper.find('[data-test="provider"]').setValue('codex');
    await wrapper.find('[data-test="model"]').setValue('gpt-5.1');
    await wrapper.find('[data-test="my-model-extract_manual"]').setValue('gpt-5.1-codex-mini');
    await wrapper.find('[data-test="save-settings"]').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/llm/settings', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1',
      llm_models: { find_manual: '', analyze_manual: '', extract_manual: 'gpt-5.1-codex-mini' },
    });
  });

  it('shows a quota pause and lifts it', async () => {
    api.get.mockResolvedValue(
      llmStatus({
        accounts: {
          claude: claudeAccount({
            paused_until: '2026-08-19T00:00:00Z',
            paused_reason: 'usage limit reached',
          }),
          codex: null,
        },
      })
    );
    const wrapper = mount(LlmSettingsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="claude-paused"]').text()).toContain('usage limit reached');

    api.post.mockResolvedValue(
      llmStatus({ accounts: { claude: claudeAccount(), codex: null } })
    );
    await wrapper.find('[data-test="claude-resume"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/llm/claude/resume');
    expect(wrapper.find('[data-test="claude-paused"]').exists()).toBe(false);
  });

  it('saves a pasted codex auth.json', async () => {
    api.get.mockResolvedValue(llmStatus());
    const wrapper = mount(LlmSettingsView, { global: testGlobal() });
    await flushPromises();

    api.post.mockResolvedValue(
      llmStatus({
        accounts: { claude: null, codex: claudeAccount({ provider: 'codex', kind: 'auth_json' }) },
      })
    );
    await wrapper.find('[data-test="codex-auth-json"]').setValue('{"tokens":{}}');
    await wrapper.find('[data-test="codex-panel"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/llm/codex/auth-json', {
      auth_json: '{"tokens":{}}',
    });
    expect(wrapper.find('[data-test="codex-status"]').text()).toContain('auth.json');
  });
});
