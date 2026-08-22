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
    expect(wrapper.find('[data-test="ask-about-patch"]').attributes('to')).toBe('/patches/7/questions');
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

  // A menu-driven module's settings hang off the JACK they configure, and one
  // jack carries as many of them as its menu has entries — which is why they
  // are keyed by the parameter rather than by the component.
  it('dials in the menu settings of a module that has them', async () => {
    const withMenu = structuredClone(patchResponse);
    const maths = withMenu.modules.find((m) => m.id === 11);
    maths.parameters = [
      {
        id: 101,
        component_id: 2,
        name: 'Clock division',
        value_type: 'enum',
        options: [
          { id: 1, value: '/4', description: 'Four times slower' },
          { id: 2, value: 'x2', description: null },
        ],
        default_value: null,
        value_min: null,
        value_max: null,
        unit: null,
        description: 'How fast EOR runs against the clock.',
      },
      {
        id: 102,
        component_id: null,
        name: 'Tempo',
        value_type: 'number',
        options: [],
        default_value: '120',
        value_min: '10',
        value_max: '300',
        unit: 'BPM',
        description: null,
      },
    ];
    withMenu.settings = [
      {
        id: 33,
        patch_module_id: 11,
        component_id: 2,
        component_name: 'EOR',
        parameter_id: 101,
        parameter_name: 'Clock division',
        value: '/4',
      },
    ];
    api.get.mockResolvedValue(withMenu);
    api.put.mockResolvedValue({ id: 34 });
    const wrapper = mount(PatchSettingsView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // A recorded menu value says which jack and which menu entry it is.
    expect(wrapper.find('[data-test="setting-33"]').text()).toContain('EOR · Clock division');

    await pick(wrapper, 'settings-module', 'maths');
    // The listed settings become a dropdown, prefilled from what is recorded.
    const division = wrapper.find('[data-test="parameter-input-101"]');
    expect(division.element.tagName).toBe('SELECT');
    expect(division.element.value).toBe('/4');
    expect(division.findAll('option').map((o) => o.text()).join(' ')).toContain('Four times slower');
    // A range with no listed settings is a number, prefilled from the default.
    const tempo = wrapper.find('[data-test="parameter-input-102"]');
    expect(tempo.attributes('type')).toBe('number');
    expect(tempo.element.value).toBe('120');

    await division.setValue('x2');
    await wrapper.find('[data-test="parameter-save-101"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/settings', {
      patch_module_id: 11,
      parameter_id: 101,
      value: 'x2',
    });
  });
});
