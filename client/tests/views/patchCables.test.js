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
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7/cables' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import PatchCablesView from '../../src/views/PatchCablesView.vue';
import { krellPatch, richPatch, switchPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchCablesView', () => {
  const patchResponse = krellPatch;

  // The row-level removals ask before they act — except unplugging a cable,
  // which is the ordinary motion of patching and stays a single click.
  // Pulling a cable out is what patching is: it is not gated behind a
  // question, the way everything on the configuration page is.
  it('unplugs a cable without a question', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-cable-21"]').trigger('click');
    await flushPromises();
    expect(confirm).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/21');
  });

  it('finds each end of a cable by typing and plugs it in', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // Typing lists the matching modules with the first one highlighted.
    const from = wrapper.find('[data-test="cable-from-module"]');
    await from.trigger('focus');
    await from.setValue('make noise');
    const options = wrapper.findAll('[data-test^="cable-from-module-option-"]');
    expect(options).toHaveLength(1);
    expect(options[0].text()).toContain('Make Noise Maths');
    expect(options[0].classes()).toContain('ac-active');
    await from.trigger('keydown', { key: 'Enter' });
    expect(from.element.value).toBe('Make Noise Maths');

    // Picking the module lists its jacks, which are found the same way.
    await pick(wrapper, 'cable-from-jack', 'eor');
    await pick(wrapper, 'cable-to-module', 'doepfer');
    await pick(wrapper, 'cable-to-jack', 'm1');
    await wrapper.find('[data-test="cable-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 13,
      to_component_id: 5,
    });
  });

  it('moves the highlight with the arrow keys', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await pick(wrapper, 'cable-to-module', 'doepfer');
    const jack = wrapper.find('[data-test="cable-to-jack"]');
    await jack.trigger('focus');
    await jack.setValue('m');
    const highlighted = () =>
      wrapper.findAll('[data-test^="cable-to-jack-option-"]').findIndex((o) =>
        o.classes().includes('ac-active')
      );
    expect(highlighted()).toBe(0);
    await jack.trigger('keydown', { key: 'ArrowDown' });
    expect(highlighted()).toBe(1);
    // Past the end it wraps back to the first match.
    await jack.trigger('keydown', { key: 'ArrowDown' });
    expect(highlighted()).toBe(0);
    await jack.trigger('keydown', { key: 'ArrowUp' });
    expect(highlighted()).toBe(1);
    await jack.trigger('keydown', { key: 'Enter' });
    expect(jack.element.value).toBe('M2 (mult 1)');
  });

  it('shows an input that already has a cable in it as unavailable', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // Maths' Signal In is fed by the patch's one cable.
    await pick(wrapper, 'cable-to-module', 'maths');
    const jack = wrapper.find('[data-test="cable-to-jack"]');
    await jack.trigger('focus');
    await jack.setValue('signal');
    const option = wrapper.find('[data-test="cable-to-jack-option-1"]');
    expect(option.text()).toContain('in use — EOR is patched here');
    expect(option.classes()).toContain('ac-disabled');
    // ...and it cannot be taken, by Enter or by clicking it.
    await jack.trigger('keydown', { key: 'Enter' });
    await option.trigger('mousedown');
    expect(wrapper.find('[data-test="cable-create"]').attributes('disabled')).toBeDefined();
  });

  it('plugs a cable from one typed line', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const line = wrapper.find('[data-test="quick-cable"]');
    // Half a line explains itself instead of failing silently.
    await line.setValue('maths eor');
    expect(wrapper.find('[data-test="quick-problem"]').text()).toContain('Name both ends');
    expect(wrapper.find('[data-test="quick-create"]').attributes('disabled')).toBeDefined();

    // An end that names several jacks lists them rather than guessing.
    await line.setValue('maths eor > doepfer m');
    expect(wrapper.find('[data-test="quick-problem"]').text()).toContain('2 different jacks');
    expect(wrapper.find('[data-test="quick-matches"]').text()).toContain('M1');

    // An input that already has a cable in it is refused by name.
    await line.setValue('maths eor > maths signal in');
    expect(wrapper.find('[data-test="quick-problem"]').text()).toContain('already has a cable');

    await line.setValue('maths eor > doepfer m1');
    expect(wrapper.find('[data-test="quick-preview"]').text()).toContain(
      'Make Noise Maths — EOR → Doepfer A-180-2 — M1'
    );
    await wrapper.find('[data-test="quick-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 13,
      to_component_id: 5,
    });
    expect(wrapper.find('[data-test="quick-cable"]').element.value).toBe('');
  });

  it('reuses an existing cable and turns a reversible one around', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 23 });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The patch's cable runs EOR → Signal In, both fixed-direction jacks, so
    // there is nothing to reverse.
    expect(wrapper.find('[data-test="cable-reverse-21"]').exists()).toBe(false);

    await wrapper.find('[data-test="cable-reuse-21"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="cable-from-module"]').element.value).toBe('Make Noise Maths');
    expect(wrapper.find('[data-test="cable-from-jack"]').element.value).toBe('EOR');
    expect(wrapper.find('[data-test="cable-to-jack"]').element.value).toBe('Signal In');

    // A cable between two mult jacks can be turned around.
    api.get.mockResolvedValue({
      ...patchResponse,
      cables: [
        {
          id: 24,
          from_patch_module_id: 13,
          from_component_id: 5,
          from_component_name: 'M1',
          to_patch_module_id: 13,
          to_component_id: 6,
          to_component_name: 'M2',
        },
      ],
    });
    const mults = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await mults.find('[data-test="cable-reverse-24"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables/24/reverse', {});
  });

  it('offers cables from other patches and flags loose ends', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/patches/7/suggestions') {
        return {
          suggestions: [
            {
              from_patch_module_id: 11,
              from_component_id: 2,
              from_component_name: 'EOR',
              to_patch_module_id: 13,
              to_component_id: 5,
              to_component_name: 'M1',
              patches: 3,
            },
          ],
        };
      }
      return patchResponse;
    });
    api.post.mockResolvedValue({ id: 25 });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const row = wrapper.find('[data-test="suggestion-2-5"]');
    expect(row.text()).toContain('Make Noise Maths — EOR');
    expect(row.text()).toContain('in 3 other patches');
    await wrapper.find('[data-test="plug-suggestion-2-5"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 13,
      to_component_id: 5,
    });

    // Maths is fed by the patch's one cable and sends nothing onward... which
    // it also sends, so it is not a loose end; nothing else is fed at all.
    expect(wrapper.find('[data-test="loose-end-11"]').exists()).toBe(false);
  });

  it('marks a module that receives signal but sends none as a loose end', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/patches/7/suggestions') return { suggestions: [] };
      return {
        ...patchResponse,
        cables: [
          {
            id: 26,
            from_patch_module_id: 13,
            from_component_id: 5,
            from_component_name: 'M1',
            to_patch_module_id: 11,
            to_component_id: 1,
            to_component_name: 'Signal In',
          },
        ],
      };
    });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // Signal reaches Maths and nothing leaves it.
    expect(wrapper.find('[data-test="loose-end-11"]').text()).toContain('Make Noise Maths');
    await wrapper.find('[data-test="patch-from-11"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="cable-from-module"]').element.value).toBe('Make Noise Maths');
  });

  it('chains the next cable from the module the last one landed in', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="cable-chain"]').setValue(true);
    await pick(wrapper, 'cable-from-module', 'make noise');
    await pick(wrapper, 'cable-from-jack', 'eor');
    await pick(wrapper, 'cable-to-module', 'doepfer');
    await pick(wrapper, 'cable-to-jack', 'm1');
    await wrapper.find('[data-test="cable-form"]').trigger('submit');
    await flushPromises();

    // The destination becomes the source of the next cable, both jacks clear.
    expect(wrapper.find('[data-test="cable-from-module"]').element.value).toBe('Doepfer A-180-2');
    expect(wrapper.find('[data-test="cable-from-jack"]').element.value).toBe('');
    expect(wrapper.find('[data-test="cable-to-module"]').element.value).toBe('');
  });

  it('offers mult jacks at both ends of a cable', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The mult module is offered at both ends even though it has no fixed
    // input/output jacks, and its jacks are labeled with their group.
    const jackNames = async (moduleBox, jackBox) => {
      await pick(wrapper, moduleBox, 'a-180-2');
      const box = wrapper.find(`[data-test="${jackBox}"]`);
      await box.trigger('focus');
      return wrapper
        .findAll(`[data-test^="${jackBox}-option-"]`)
        .map((o) => o.text())
        .join(' ');
    };
    expect(await jackNames('cable-from-module', 'cable-from-jack')).toContain('M1 (mult 1)');
    expect(await jackNames('cable-to-module', 'cable-to-jack')).toContain('M2 (mult 1)');
  });

  // A routing switch's jacks are bidirectional too and are the one thing a
  // mult is not: a switch SELECTS the other side of its section where a mult
  // COPIES to its siblings. Calling them mults in the picker is how a patch
  // gets read wrong.
  it('labels a switch section\'s jacks by their side, not as mults', async () => {
    api.get.mockResolvedValue(switchPatch);
    const wrapper = mount(PatchCablesView, { props: { id: '9' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await pick(wrapper, 'cable-from-module', 'a-151');
    const box = wrapper.find('[data-test="cable-from-jack"]');
    await box.trigger('focus');
    const options = wrapper
      .findAll('[data-test^="cable-from-jack-option-"]')
      .map((o) => o.text())
      .join(' ');
    expect(options).toContain('I/O (switch common)');
    expect(options).toContain('1 (switch step)');
    expect(options).not.toContain('(mult)');
  });
});

describe('PatchCablesView beyond the rack', () => {
  it('shows what a cable is for and lets it be marked provisional', async () => {
    api.get.mockResolvedValue(richPatch);
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchCablesView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const cable = wrapper.find('[data-test="cable-21"]');
    expect(cable.text()).toContain('adds the distortion layer');
    expect(cable.text()).toContain('optional');
    expect(cable.text()).toContain('stacked');
    expect(cable.text()).toContain('drive choice');

    await wrapper.find('[data-test="cable-optional-21"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/cables/21', { optional: false });
  });
});
