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
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1-codex',
      import_workers: 6,
      token_budget_default: 250000,
      token_budget_period: 'week',
    });
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(true);
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
