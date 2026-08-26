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
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7/gear' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import PatchGearView from '../../src/views/PatchGearView.vue';
import { richPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchGearView', () => {
  it('shows bridged links and the connection points of off-rack gear', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    expect(wrapper.find('[data-test="link-81"]').text()).toContain('bridge');
    expect(wrapper.find('[data-test="link-81"]').text()).toContain('1↔1');
    // The declared connection point of the off-rack gear is listed.
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('MIDI OUT');
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('midi din');
  });

  it('corrects an instance\'s manufacturer and module name, refusing an empty one', async () => {
    api.get.mockResolvedValue(richPatch);
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The drafts start from the snapshot the patch holds.
    expect(wrapper.find('[data-test="manufacturer-input-12"]').element.value).toBe('external');
    expect(wrapper.find('[data-test="module-name-input-12"]').element.value).toBe('UMC404HD');

    await wrapper.find('[data-test="manufacturer-input-12"]').setValue('Behringer');
    await wrapper.find('[data-test="module-name-input-12"]').setValue('  UMC404HD mk2 ');
    await wrapper.find('[data-test="name-save-12"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/modules/12', {
      manufacturer: 'Behringer',
      module_name: 'UMC404HD mk2',
    });

    // Blanking either one is refused before it reaches the server.
    api.put.mockClear();
    await wrapper.find('[data-test="module-name-input-12"]').setValue('   ');
    expect(wrapper.find('[data-test="name-save-12"]').attributes('disabled')).toBeDefined();
    // Enter reaches the same guard the disabled button hides behind.
    await wrapper.find('[data-test="module-name-input-12"]').trigger('keyup.enter');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="instance-error"]').text()).toContain('both required');
  });

  it('names a bus, labels an instance and adds off-rack gear', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockResolvedValue({ id: 99 });
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="group-name"]').setValue('Granular bus');
    await wrapper.find('[data-test="groups"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/groups', { name: 'Granular bus' });

    await wrapper.find('[data-test="label-input-13"]').setValue('case link');
    await wrapper.find('[data-test="label-save-13"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/modules/13', { label: 'case link' });

    await wrapper.find('[data-test="add-kind"]').setValue('external');
    await wrapper.find('[data-test="add-name"]').setValue('Monitors');
    await wrapper.findAll('[data-test="extras"] form')[0].trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/modules', {
      module_name: 'Monitors',
      manufacturer: undefined,
      external: true,
      label: undefined,
    });
  });

  it('declares a connection point on gear the patch invented', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockResolvedValue({ id: 91 });
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="port-module"]').setValue('12');
    await wrapper.find('[data-test="port-name"]').setValue('MAIN OUT');
    await wrapper.find('[data-test="port-type"]').setValue('input_jack');
    await wrapper.find('[data-test="port-kind"]').setValue('audio_quarter_inch');
    await wrapper.findAll('[data-test="extras"] form')[1].trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/modules/12/ports', {
      name: 'MAIN OUT',
      type: 'input_jack',
      port_kind: 'audio_quarter_inch',
    });
  });

  it('links two instances and reloads the patch', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockResolvedValue({ id: 82 });
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="link-a"]').setValue(11);
    await wrapper.find('[data-test="link-b"]').setValue(13);
    await wrapper.find('[data-test="links"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/links', {
      a_patch_module_id: 11,
      b_patch_module_id: 13,
      kind: 'bridge',
    });
    // The new link arrives with the reloaded patch.
    expect(api.get.mock.calls.filter(([path]) => path === '/api/patches/7')).toHaveLength(2);
  });

  it('shows why two instances could not be linked', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockRejectedValue(new Error('those two are already linked'));
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="link-a"]').setValue(11);
    await wrapper.find('[data-test="link-b"]').setValue(13);
    await wrapper.find('[data-test="links"] form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('already linked');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/patches/7')).toHaveLength(1);
  });

  it('unlinks a bridged pair once the user confirms', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(richPatch);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove link', danger: true })
    );
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/links/81');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/patches/7')).toHaveLength(2);
  });

  it('keeps the link when the confirm is declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([path]) => path === '/api/patches/7')).toHaveLength(1);
  });

  it('shows why a link could not be removed', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(richPatch);
    api.delete.mockRejectedValue(new Error('link is gone already'));
    const wrapper = mount(PatchGearView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('gone already');
  });
});
