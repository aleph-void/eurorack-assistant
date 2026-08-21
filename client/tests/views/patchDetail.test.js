import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

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
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import PatchDetailView from '../../src/views/PatchDetailView.vue';
import PatchDiagram from '../../src/components/PatchDiagram.vue';
import { krellPatch, systemPatch as systemPatchFixture } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchDetailView', () => {
  const patchResponse = krellPatch;

  it('renders the snapshot note and the picture, not the cable list', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="snapshot-note"]').text()).toContain("rack 'main rack'");
    expect(wrapper.findComponent(PatchDiagram).exists()).toBe(true);
    // The cables are written out on a page of their own.
    expect(wrapper.find('[data-test="cable-21"]').exists()).toBe(false);
    // The patch can be taken straight to the assistant.
    expect(wrapper.find('[data-test="ask-about-patch"]').attributes('to')).toBe('/ask?patch=7');
  });

  it('asks before matching the patch to the rack as it is organised now', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ ok: true, rows: 2 });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The patch draws the studio as it stood, so catching it up is asked for.
    await wrapper.find('[data-test="resync-layout"]').trigger('click');
    await flushPromises();
    expect(confirm.mock.calls[0][0].message).toContain("rack 'main rack'");
    expect(api.post).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    api.get.mockClear();
    await wrapper.find('[data-test="resync-layout"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/rack-layout/resync');
    // The page re-reads the patch, so the diagram redraws.
    expect(api.get).toHaveBeenCalledWith('/api/patches/7');
  });

  it('creates a cable emitted by the diagram drag gesture', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 11,
      to_component_id: 1,
    });
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 11,
      to_component_id: 1,
    });
  });

  it('deletes a cable the diagram asks to unplug', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.delete.mockResolvedValue({});
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('disconnect', { id: 21 });
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/21');
  });

  // Which way a jack runs is a fact about the MODULE, so correcting it from
  // the picture writes to the module and every patch drawing it follows.
  it('corrects a jack the diagram says runs the wrong way', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockResolvedValue({ id: 1, type: 'bidirectional_jack' });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('retype', {
      module_id: 3,
      patch_module_id: 11,
      component_id: 1,
      name: 'EOR',
      type: 'bidirectional_jack',
    });
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/3/components/1', {
      type: 'bidirectional_jack',
    });
    expect(api.get).toHaveBeenCalledWith('/api/patches/7');
  });

  it('duplicates the patch and opens the copy', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 99, name: 'Krell (copy)' });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="duplicate-patch"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/clone', {});
    expect(routerPush).toHaveBeenCalledWith('/patches/99');
  });
});

describe('PatchDetailView system patches', () => {
  const systemPatch = systemPatchFixture;

  it('says the patch spans a system, and names each module’s rack', async () => {
    api.get.mockResolvedValue(systemPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const note = wrapper.find('[data-test="snapshot-note"]').text();
    expect(note).toContain("system 'studio'");
    expect(note).toContain('any jack on any of those racks');
    // The rack rides along in the name the diagram and cable list use,
    // which is what tells two identical modules in two cases apart.
    expect(wrapper.findComponent(PatchDiagram).props('labelFor')(systemPatch.modules[0])).toBe(
      'Make Noise Maths · left case'
    );
  });

  it('hands the diagram the rows of every rack in the system', async () => {
    api.get.mockResolvedValue(systemPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    const rows = wrapper.findComponent(PatchDiagram).props('rackRows');
    expect(rows.map((row) => row.rack_name)).toEqual(['left case', 'right case']);
  });

  it('leaves a single-rack patch as it was', async () => {
    // The same payload with one rack behind it: no system, one rack name.
    api.get.mockResolvedValue({
      ...systemPatch,
      rack_id: 10,
      rack_name: 'left case',
      system_id: null,
      system_name: null,
      modules: systemPatch.modules.map((pm) => ({ ...pm, rack_id: 10, rack_name: 'left case' })),
    });
    const wrapper = mount(PatchDetailView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    expect(wrapper.find('[data-test="snapshot-note"]').text()).toContain("rack 'left case'");
  });
});
