import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) };
});

import { api } from '../../src/api.js';
import CompositionMappingView from '../../src/views/CompositionMappingView.vue';
import { tide, tideOnKrell } from '../compositionFixtures.js';
import { richPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (path) => {
    if (path === '/api/compositions/3') return tide;
    if (path === '/api/compositions/3/patches/7') return tideOnKrell;
    if (path === '/api/patches/7') return richPatch;
    throw new Error(`unexpected GET ${path}`);
  });
});

const mountView = () =>
  mount(CompositionMappingView, { props: { id: '3', patchId: '7' }, global: testGlobal() });

describe('CompositionMappingView', () => {
  it('shows each part with what plays it, marking a binding whose target has gone', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain("On 'Krell'");
    expect(wrapper.find('[data-test="up-to-storyboard"]').text()).toBe('Tide');
    expect(wrapper.find('[data-test="coverage"]').text()).toBe('1 of 2 parts mapped');

    const bass = wrapper.find('[data-test="binding-row-20"]');
    expect(bass.find('[data-test="mapping-50"]').text()).toContain('Make Noise Maths · Rise');
    expect(bass.find('[data-test="mapping-50"]').text()).toContain('ride it');
    expect(bass.find('[data-test="mapping-51"] [data-test="stale"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="binding-row-21"] [data-test="unmapped"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="notes-input"]').element.value).toBe('the small-case version');
  });

  it('binds a part to one control of an instance, picked from the patch', async () => {
    api.post.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="bind-21"]').trigger('click');
    const form = wrapper.find('[data-test="bind-form-21"]');
    await form.find('[data-test="target-kind"]').setValue('component');
    await form.find('[data-test="pick-module"]').setValue('11');
    // The component picker offers that instance's own components.
    const options = form.findAll('[data-test="pick-component"] option').map((o) => o.text());
    expect(options.some((t) => t.startsWith('OUT'))).toBe(true);
    await form.find('[data-test="pick-component"]').setValue('1');
    await form.find('[data-test="bind-note"]').setValue('never below 9');
    await form.trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/compositions/3/patches/7/mappings', {
      element_id: 21,
      patch_module_id: 11,
      component_id: 1,
      note: 'never below 9',
    });
    // The mapping and the composition are re-read; the patch is not.
    expect(api.get.mock.calls.filter(([p]) => p === '/api/compositions/3/patches/7')).toHaveLength(2);
    expect(api.get.mock.calls.filter(([p]) => p === '/api/patches/7')).toHaveLength(1);
  });

  it('binds a part to a bus and to a cable, named the way the patch names them', async () => {
    api.post.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="bind-21"]').trigger('click');
    const form = wrapper.find('[data-test="bind-form-21"]');
    await form.find('[data-test="target-kind"]').setValue('group');
    const group = richPatch.groups[0];
    await form.find('[data-test="pick-group"]').setValue(String(group.id));
    await form.trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/compositions/3/patches/7/mappings', {
      element_id: 21,
      group_id: group.id,
      note: '',
    });

    await form.find('[data-test="target-kind"]').setValue('cable');
    const cableOptions = form.findAll('[data-test="pick-cable"] option').map((o) => o.text());
    expect(cableOptions.some((t) => t.includes('→'))).toBe(true);
    const cable = richPatch.cables[0];
    await form.find('[data-test="pick-cable"]').setValue(String(cable.id));
    await form.trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/compositions/3/patches/7/mappings', {
      element_id: 21,
      cable_id: cable.id,
      note: '',
    });
  });

  it('removes a binding and saves the notes', async () => {
    api.delete.mockResolvedValue({ ok: true });
    api.put.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="mapping-51"] [data-test="unbind"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/compositions/3/patches/7/mappings/51');

    await wrapper.find('[data-test="notes-input"]').setValue('bring the second case');
    await wrapper.find('[data-test="notes-form"]').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/patches/7', { notes: 'bring the second case' });
  });

  it('draws the performance sheet: the storyboard with each part headed by what plays it', async () => {
    const wrapper = mountView();
    await flushPromises();

    const bass = wrapper.find('[data-test="sheet-row-20"]');
    expect(bass.text()).toContain('Make Noise Maths · Rise');
    // A stale binding is not on the sheet: it names nothing in the patch.
    expect(bass.text()).not.toContain('ALM Pam');
    expect(bass.text()).toContain('Changes');
    expect(bass.text()).toContain('open the filter');
    expect(wrapper.find('[data-test="sheet-row-21"]').text()).toContain('not mapped');
  });
});
