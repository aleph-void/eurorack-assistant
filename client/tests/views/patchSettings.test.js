import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, pick, testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7/settings' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import PatchSettingsView from '../../src/views/PatchSettingsView.vue';
import { krellPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchSettingsView', () => {
  const patchResponse = krellPatch;

  // The row-level removals ask before they act — except unplugging a cable,
  // which is the ordinary motion of patching and stays a single click.
  // Everything on this page is gated behind a question, and a declined one
  // acts on nothing.
  it('asks before removing a setting', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchSettingsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-setting-31"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="delete-setting-31"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/settings/31');
  });

  it('renders the settings, under the patch it belongs to', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchSettingsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    expect(wrapper.find('[data-test="setting-31"]').text()).toContain('Rise');
    // Every patch page carries the patch's own header.
    expect(wrapper.find('h1').text()).toContain('Krell');
    expect(wrapper.find('[data-test="ask-about-patch"]').attributes('to')).toBe('/ask?patch=7');
  });

  it('offers enum options as a dropdown and ranges as numbers when dialing in a module', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockResolvedValue({ id: 32 });
    const wrapper = mount(PatchSettingsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await pick(wrapper, 'settings-module', 'maths');
    // Rise has min/max 0..10 → a number input, prefilled from the saved setting.
    const rise = wrapper.find('[data-test="control-input-3"]');
    expect(rise.attributes('type')).toBe('number');
    expect(rise.attributes('max')).toBe('10');
    expect(rise.element.value).toBe('7');
    // Mode has enum positions → a select.
    const mode = wrapper.find('[data-test="control-input-4"]');
    expect(mode.element.tagName).toBe('SELECT');
    expect(mode.findAll('option').map((o) => o.text()).join(' ')).toContain('Cycle');

    await mode.setValue('Cycle');
    await wrapper.find('[data-test="control-save-4"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/settings', {
      patch_module_id: 11,
      component_id: 4,
      value: 'Cycle',
    });
  });
});
