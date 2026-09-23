import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, path: '/patches/7/settings' }),
  };
});

import { api } from '../src/api.js';
import GenerateMoreSection from '../src/components/patchdetail/GenerateMoreSection.vue';
import PatchSettingsView from '../src/views/PatchSettingsView.vue';
import PatchCablesView from '../src/views/PatchCablesView.vue';
import { krellPatch } from './patchFixtures.js';

beforeEach(() => vi.clearAllMocks());

describe('GenerateMoreSection', () => {
  const mountIt = async (patch = krellPatch) => {
    const wrapper = mount(GenerateMoreSection, {
      props: { patch, patchId: '7' },
      global: testGlobal(),
    });
    await openPanels(wrapper);
    await flushPromises();
    return wrapper;
  };

  it('asks for more cables on top of what the patch holds, to the brief given', async () => {
    api.post.mockResolvedValue({ id: 7, generating: true, job_id: 3 });
    const wrapper = await mountIt();
    // The budget offered is the patch's cables plus a handful more.
    const cables = krellPatch.cables.length;
    expect(wrapper.find('[data-test="generate-more-max"]').element.value).toBe(String(cables + 6));
    expect(wrapper.find('[data-test="generate-more"]').text()).toBe('Generate');
    await wrapper.find('[data-test="generate-more-brief"]').setValue(' more modulation ');
    await wrapper.find('[data-test="generate-more-max"]').setValue(String(cables + 2));
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/generate', {
      max_cables: cables + 2,
      prompt: 'more modulation',
    });
    expect(wrapper.find('[data-test="generate-more-notice"]').text()).toContain('background');
    expect(wrapper.emitted('reload')).toHaveLength(1);
    expect(wrapper.find('[data-test="generate-more-brief"]').element.value).toBe('');
  });

  it('names the instances to use, and whether they are the only ones', async () => {
    api.post.mockResolvedValue({ id: 7, generating: true, job_id: 3 });
    const wrapper = await mountIt();
    expect(wrapper.find('[data-test="generate-more-only"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="generate-more-module-11"]').setValue(true);
    await wrapper.find('[data-test="generate-more-module-13"]').setValue(true);
    await wrapper.find('[data-test="generate-more-only"]').setValue(true);
    expect(wrapper.find('[data-test="generate-more-modules-count"]').text()).toContain('2 chosen, and only those');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/generate', {
      max_cables: krellPatch.cables.length + 6,
      prompt: undefined,
      patch_module_ids: [11, 13],
      only_modules: true,
    });
  });

  it('offers a settings review when the budget is already met, and waits while a job runs', async () => {
    const wrapper = await mountIt();
    await wrapper.find('[data-test="generate-more-max"]').setValue(String(krellPatch.cables.length));
    expect(wrapper.find('[data-test="generate-more"]').text()).toBe('Review settings');

    const busy = await mountIt({ ...krellPatch, generating: true });
    expect(busy.find('[data-test="generate-more"]').attributes('disabled')).toBeDefined();
    expect(busy.find('[data-test="generate-more"]').text()).toBe('Generating…');
  });

  it('says so when the server refuses', async () => {
    api.post.mockRejectedValue(new Error("'Krell' is already being generated"));
    const wrapper = await mountIt();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="generate-more-error"]').text()).toContain('already being generated');
  });

  it('is on the settings page and the cables page, since a patch is more than its connections', async () => {
    api.get.mockResolvedValue(krellPatch);
    for (const View of [PatchSettingsView, PatchCablesView]) {
      const wrapper = mount(View, { props: { id: '7' }, global: testGlobal() });
      await flushPromises();
      expect(wrapper.find('[data-test="generate-more-section"]').exists()).toBe(true);
    }
  });
});
