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
import ConfigView from '../../src/views/ConfigView.vue';
import { useSiteStore } from '../../src/stores/site.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ConfigView', () => {
  const configResponse = {
    llm_provider: 'claude',
    llm_model: '',
    import_workers: '4',
    providers: ['claude', 'codex'],
    known_models: { claude: ['claude-fable-5'], codex: ['gpt-5.1-codex'] },
    default_models: { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' },
    token_budget_default: '0',
    token_budget_period: 'month',
    youtube_api_key: '',
    discord_invite_url: '',
    max_active_users: '0',
  };

  it('loads current config and saves changes', async () => {
    api.get.mockResolvedValue(configResponse);
    api.put.mockResolvedValue({ llm_provider: 'codex', llm_model: 'gpt-5.1-codex' });
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="provider"]').element.value).toBe('claude');
    expect(wrapper.find('[data-test="import-workers"]').element.value).toBe('4');
    // Per-job-type models moved to each user's own LLM settings page.
    expect(wrapper.find('[data-test="model-find_manual"]').exists()).toBe(false);

    await wrapper.find('[data-test="provider"]').setValue('codex');
    await wrapper.find('[data-test="model"]').setValue('gpt-5.1-codex');
    await wrapper.find('[data-test="import-workers"]').setValue('6');
    // A token budget is off (0) until an admin sets one here.
    expect(wrapper.find('[data-test="token-budget-default"]').element.value).toBe('0');
    await wrapper.find('[data-test="token-budget-default"]').setValue('250000');
    await wrapper.find('[data-test="token-budget-period"]').setValue('week');
    await wrapper.find('[data-test="youtube-api-key"]').setValue('AIzaTestKey123');
    await wrapper.find('[data-test="discord-invite-url"]').setValue('discord.gg/abc123');
    // Registration is open to any number until an admin sets a ceiling here.
    expect(wrapper.find('[data-test="max-active-users"]').element.value).toBe('0');
    await wrapper.find('[data-test="max-active-users"]').setValue('25');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1-codex',
      import_workers: 6,
      token_budget_default: 250000,
      token_budget_period: 'week',
      youtube_api_key: 'AIzaTestKey123',
      discord_invite_url: 'discord.gg/abc123',
      max_active_users: 25,
    });
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(true);
  });

  it('shows the Discord invite as the server kept it, and hands it to the footer', async () => {
    api.get.mockResolvedValue({ ...configResponse, discord_invite_url: 'https://discord.gg/old' });
    api.put.mockResolvedValue({ ...configResponse, discord_invite_url: 'https://discord.gg/new' });
    const wrapper = mount(ConfigView, { global: testGlobal() });
    const site = useSiteStore();
    await flushPromises();
    expect(wrapper.find('[data-test="discord-invite-url"]').element.value).toBe(
      'https://discord.gg/old'
    );

    // A bare host is sent as typed; the server answers with the https URL it
    // stored, which is what the field and this page's footer then show.
    await wrapper.find('[data-test="discord-invite-url"]').setValue('discord.gg/new');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put.mock.calls[0][1].discord_invite_url).toBe('discord.gg/new');
    expect(wrapper.find('[data-test="discord-invite-url"]').element.value).toBe(
      'https://discord.gg/new'
    );
    expect(site.discordInviteUrl).toBe('https://discord.gg/new');
  });

  it('shows the active-user ceiling as stored', async () => {
    api.get.mockResolvedValue({ ...configResponse, max_active_users: '12' });
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="max-active-users"]').element.value).toBe('12');
  });

  it('shows save errors', async () => {
    api.get.mockResolvedValue(configResponse);
    api.put.mockRejectedValue(new Error('Invalid llm_provider: nope'));
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Invalid llm_provider');
  });
});
