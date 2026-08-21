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
import { dialog } from '../../src/dialog.js';
import PatchDetailView from '../../src/views/PatchDetailView.vue';
import PatchDiagram from '../../src/components/PatchDiagram.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchDetailView', () => {
  const patchResponse = {
    id: 7,
    name: 'Krell',
    description: null,
    rack_id: 1,
    rack_name: 'main rack',
    created_at: '2026-08-12T10:00:00Z',
    modules: [
      {
        id: 11,
        module_id: 1,
        manufacturer: 'Make Noise',
        module_name: 'Maths',
        instance: 1,
        live: true,
        components: [
          { id: 1, type: 'input_jack', name: 'Signal In', values: [] },
          { id: 2, type: 'output_jack', name: 'EOR', values: [] },
          {
            id: 3,
            type: 'knob',
            name: 'Rise',
            values: [
              { id: 1, type: 'min', value: '0' },
              { id: 2, type: 'max', value: '10' },
            ],
          },
          {
            id: 4,
            type: 'switch',
            name: 'Mode',
            values: [
              { id: 3, type: 'enum', value: 'Cycle' },
              { id: 4, type: 'enum', value: 'Sustain' },
            ],
          },
        ],
      },
      {
        id: 12,
        module_id: 2,
        manufacturer: 'ALM',
        module_name: 'Pam',
        instance: 1,
        live: false,
        components: [],
      },
      {
        id: 13,
        module_id: 3,
        manufacturer: 'Doepfer',
        module_name: 'A-180-2',
        instance: 1,
        live: true,
        components: [
          { id: 5, type: 'bidirectional_jack', name: 'M1', group_label: '1', values: [] },
          { id: 6, type: 'bidirectional_jack', name: 'M2', group_label: '1', values: [] },
        ],
      },
    ],
    cables: [
      {
        id: 21,
        from_patch_module_id: 11,
        from_component_id: 2,
        from_component_name: 'EOR',
        to_patch_module_id: 11,
        to_component_id: 1,
        to_component_name: 'Signal In',
      },
    ],
    settings: [
      { id: 31, patch_module_id: 11, component_id: 3, component_name: 'Rise', value: '7' },
    ],
    normalizations: [
      {
        patch_module_id: 11,
        normalization_id: 41,
        target_component_id: 1,
        target_component_name: 'Signal In',
        source_component_id: null,
        source_component_name: null,
        source_label: 'internal oscillator',
        kind: 'internal',
        description: null,
        active: false,
        overriding_cable_id: 21,
        signals: [],
      },
      {
        patch_module_id: 13,
        normalization_id: 42,
        target_component_id: 6,
        target_component_name: 'M2',
        source_component_id: 5,
        source_component_name: 'M1',
        source_label: null,
        kind: 'input',
        description: null,
        active: true,
        overriding_cable_id: null,
        signals: [
          {
            kind: 'cable',
            cable_id: 21,
            from_patch_module_id: 11,
            from_component_id: 2,
            from_component_name: 'EOR',
            via: ['M1'],
          },
        ],
      },
    ],
    flow: [
      {
        key: 'pm11:c2',
        kind: 'jack',
        patch_module_id: 11,
        component_id: 2,
        name: 'EOR',
        jack_type: 'output_jack',
        via: null,
        merge: false,
        cycle: false,
        children: [
          {
            key: 'pm13:c5',
            kind: 'jack',
            patch_module_id: 13,
            component_id: 5,
            name: 'M1',
            jack_type: 'bidirectional_jack',
            via: 'cable',
            merge: false,
            cycle: false,
            children: [
              {
                key: 'pm13:c6',
                kind: 'jack',
                patch_module_id: 13,
                component_id: 6,
                name: 'M2',
                jack_type: 'bidirectional_jack',
                via: 'mult',
                merge: true,
                cycle: false,
                children: [
                  {
                    key: 'pm13:c5',
                    kind: 'jack',
                    patch_module_id: 13,
                    component_id: 5,
                    name: 'M1',
                    jack_type: 'bidirectional_jack',
                    via: 'route',
                    merge: false,
                    cycle: true,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  // The row-level removals ask before they act — except unplugging a cable,
  // which is the ordinary motion of patching and stays a single click.
  it('asks before removing, but unplugs a cable without a question', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-cable-21"]').trigger('click');
    await flushPromises();
    expect(confirm).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/cables/21');

    // Everything else on the page is gated, and a declined question acts on
    // nothing.
    api.delete.mockClear();
    await wrapper.find('[data-test="delete-setting-31"]').trigger('click');
    await wrapper.find('[data-test="remove-instance-12"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="delete-setting-31"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/7/settings/31');
  });

  it('renders the snapshot, cables and settings', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="snapshot-note"]').text()).toContain("rack 'main rack'");
    const cable = wrapper.find('[data-test="cable-21"]');
    expect(cable.text()).toContain('EOR');
    expect(cable.text()).toContain('Signal In');
    expect(wrapper.find('[data-test="setting-31"]').text()).toContain('Rise');
    // A module deleted since the snapshot still shows, marked as gone.
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('no longer in your system');
    // The patch can be taken straight to the assistant.
    expect(wrapper.find('[data-test="ask-about-patch"]').attributes('to')).toBe('/ask?patch=7');
  });

  it('asks before matching the patch to the rack as it is organised now', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ ok: true, rows: 2 });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  // Typing into a picker, then taking the highlighted match with Enter.
  async function pick(wrapper, test, text) {
    const input = wrapper.find(`[data-test="${test}"]`);
    await input.trigger('focus');
    await input.setValue(text);
    await input.trigger('keydown', { key: 'Enter' });
    return input;
  }

  it('finds each end of a cable by typing and plugs it in', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  // An expansion header is the ribbon connector an expander's cable plugs
  // into, behind the panel: signal crosses it, but never a patch cable.
  it('never offers an expansion header as an end of a cable', async () => {
    const withHeader = {
      ...patchResponse,
      modules: patchResponse.modules.map((pm) =>
        pm.id === 11
          ? {
              ...pm,
              components: [
                ...pm.components,
                { id: 99, type: 'input_jack', name: 'EXP', port_kind: 'ribbon', values: [] },
              ],
            }
          : pm
      ),
    };
    api.get.mockResolvedValue(withHeader);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await pick(wrapper, 'cable-to-module', 'maths');
    const jack = wrapper.find('[data-test="cable-to-jack"]');
    await jack.trigger('focus');
    await jack.setValue('exp');
    expect(wrapper.findAll('[data-test^="cable-to-jack-option-"]')).toHaveLength(0);
  });

  it('shows an input that already has a cable in it as unavailable', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const mults = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    // Signal reaches Maths and nothing leaves it.
    expect(wrapper.find('[data-test="loose-end-11"]').text()).toContain('Make Noise Maths');
    await wrapper.find('[data-test="patch-from-11"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="cable-from-module"]').element.value).toBe('Make Noise Maths');
  });

  it('duplicates the patch and opens the copy', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 99, name: 'Krell (copy)' });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="duplicate-patch"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/clone', {});
    expect(routerPush).toHaveBeenCalledWith('/patches/99');
  });

  it('chains the next cable from the module the last one landed in', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  it('renders the signal flow as an indented tree with source, merge and cycle badges', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    const root = wrapper.find('[data-test="flow-row-0"]');
    expect(root.text()).toContain('Make Noise Maths — EOR');
    expect(root.text()).toContain('generator');

    const hop = wrapper.find('[data-test="flow-row-1"]');
    expect(hop.text()).toContain('cable →');
    expect(hop.text()).toContain('Doepfer A-180-2 — M1');

    const merged = wrapper.find('[data-test="flow-row-2"]');
    expect(merged.text()).toContain('mult copy →');
    expect(merged.text()).toContain('merge point');

    const looped = wrapper.find('[data-test="flow-row-3"]');
    expect(looped.text()).toContain('feedback loop');
  });

  it('labels switch positions and distinguishes switched selection from mixing', async () => {
    api.get.mockResolvedValue({
      ...patchResponse,
      flow: [
        {
          key: 'pm11:c2',
          kind: 'jack',
          patch_module_id: 11,
          component_id: 2,
          name: 'EOR',
          jack_type: 'output_jack',
          via: null,
          switched: false,
          merge: false,
          switched_merge: false,
          cycle: false,
          children: [
            {
              key: 'pm13:c5',
              kind: 'jack',
              patch_module_id: 13,
              component_id: 5,
              name: 'I/O 1',
              jack_type: 'bidirectional_jack',
              via: 'switch',
              switched: true,
              merge: false,
              switched_merge: false,
              cycle: false,
              children: [
                {
                  key: 'pm13:c6',
                  kind: 'jack',
                  patch_module_id: 13,
                  component_id: 6,
                  name: 'O/I',
                  jack_type: 'bidirectional_jack',
                  via: 'switch',
                  switched: true,
                  merge: false,
                  switched_merge: true,
                  cycle: false,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    const step = wrapper.find('[data-test="flow-row-1"]');
    expect(step.text()).toContain('switch position →');
    expect(step.text()).toContain('one switch position');
    // A switched convergence is a selection, not a mix.
    const common = wrapper.find('[data-test="flow-row-2"]');
    expect(common.text()).toContain('switched — one source at a time');
    expect(common.text()).not.toContain('merge point');
  });

  it('shows normalled connections as active (with the traced signal) or overridden', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    const overridden = wrapper.find('[data-test="normalled-11-41"]');
    expect(overridden.text()).toContain('Signal In');
    expect(overridden.text()).toContain('internal oscillator');
    expect(overridden.text()).toContain('overridden');

    const active = wrapper.find('[data-test="normalled-13-42"]');
    expect(active.text()).toContain('active');
    expect(active.text()).toContain('receives EOR from Make Noise Maths (via M1)');
  });

  it('offers mult jacks at both ends of a cable', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  it('offers enum options as a dropdown and ranges as numbers when dialing in a module', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockResolvedValue({ id: 32 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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


describe('PatchDetailView beyond the rack', () => {
  const richPatch = {
    id: 7,
    name: 'Full system',
    description: null,
    rack_id: 1,
    rack_name: 'main rack',
    created_at: '2026-08-12T10:00:00Z',
    modules: [
      {
        id: 11,
        module_id: 1,
        manufacturer: 'Erica Synths',
        module_name: 'LXR',
        instance: 1,
        label: 'snare voice',
        group_id: 5,
        external: false,
        live: true,
        components: [{ id: 1, type: 'output_jack', name: 'OUT', values: [] }],
      },
      {
        id: 12,
        module_id: null,
        manufacturer: 'external',
        module_name: 'UMC404HD',
        instance: 1,
        label: 'the computer',
        group_id: null,
        external: true,
        live: false,
        components: [
          { id: 90, type: 'output_jack', name: 'MIDI OUT', port_kind: 'midi_din', declared: true, values: [] },
        ],
      },
      {
        id: 13,
        module_id: 4,
        manufacturer: 'Omnitone',
        module_name: '7Path',
        instance: 1,
        label: null,
        group_id: null,
        external: false,
        live: true,
        components: [{ id: 7, type: 'bidirectional_jack', name: '1', values: [] }],
      },
    ],
    groups: [{ id: 5, name: 'Rhythm', description: null, position: 1 }],
    links: [
      {
        id: 81,
        kind: 'bridge',
        a_patch_module_id: 13,
        b_patch_module_id: 11,
        description: null,
        jacks: [{ id: 1, a_component_id: 7, a_component_name: '1', b_component_id: 1, b_component_name: '1' }],
      },
    ],
    cables: [
      {
        id: 21,
        from_patch_module_id: 12,
        from_component_id: 90,
        from_component_name: 'MIDI OUT',
        to_patch_module_id: 11,
        to_component_id: 1,
        to_component_name: 'OUT',
        note: 'adds the distortion layer',
        optional: true,
        stacked: true,
        alt_group: 'drive choice',
      },
    ],
    settings: [],
    pairs: [],
    normalizations: [
      {
        patch_module_id: 11,
        normalization_id: 41,
        target_component_id: 1,
        target_component_name: 'R',
        source_component_id: 2,
        source_component_name: 'L',
        source_label: null,
        kind: 'output',
        break_component_name: 'L',
        break_on: 'cable_out',
        condition: { component_name: 'MIX 4', value: 'up', state: 'unset' },
        alt_group: 'mix',
        exclusive: true,
        description: null,
        active: false,
        overriding_cable_id: 21,
        signals: [],
      },
    ],
    flow: [
      {
        key: 'pm12:c90',
        kind: 'jack',
        patch_module_id: 12,
        component_id: 90,
        name: 'MIDI OUT',
        jack_type: 'output_jack',
        port_kind: 'midi_din',
        via: null,
        switched: false,
        conditional: false,
        condition: null,
        merge: false,
        switched_merge: false,
        cycle: false,
        truncated: false,
        truncated_tree: true,
        children: [
          {
            key: 'pm13:c7',
            kind: 'jack',
            patch_module_id: 13,
            component_id: 7,
            name: '1',
            jack_type: 'bidirectional_jack',
            port_kind: null,
            via: 'bridge',
            switched: false,
            conditional: true,
            condition: { component_name: 'MIX 4', value: 'up', state: 'unset' },
            optional: true,
            merge: false,
            switched_merge: false,
            cycle: false,
            truncated: true,
            children: [],
          },
        ],
      },
    ],
  };

  it('labels instances by their role and shows bridged links and off-rack gear', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('LXR (snare voice)');
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('Rhythm');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('off-rack gear');
    expect(wrapper.find('[data-test="link-81"]').text()).toContain('bridge');
    expect(wrapper.find('[data-test="link-81"]').text()).toContain('1↔1');
    // The declared connection point of the off-rack gear is listed.
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('MIDI OUT');
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('midi din');
  });

  it('shows what a cable is for and lets it be marked provisional', async () => {
    api.get.mockResolvedValue(richPatch);
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    const cable = wrapper.find('[data-test="cable-21"]');
    expect(cable.text()).toContain('adds the distortion layer');
    expect(cable.text()).toContain('optional');
    expect(cable.text()).toContain('stacked');
    expect(cable.text()).toContain('drive choice');

    await wrapper.find('[data-test="cable-optional-21"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/cables/21', { optional: false });
  });

  it('flags bridged, conditional, optional and cut-short paths in the flow', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="flow-row-0"]').text()).toContain('midi din');
    const bridged = wrapper.find('[data-test="flow-row-1"]');
    expect(bridged.text()).toContain('bridged link');
    expect(bridged.text()).toContain('MIX 4 set to up');
    expect(bridged.text()).toContain('not recorded in this patch');
    expect(bridged.text()).toContain('optional cable');
    expect(bridged.text()).toContain('path cut short');
    expect(wrapper.find('[data-test="flow-truncated"]').exists()).toBe(true);
  });

  it('explains a default cancelled by a cable leaving another jack', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="normalled-11-41"]');
    expect(row.text()).toContain('overridden');
    expect(row.text()).toContain('a cable is patched out of L');
    expect(row.text()).toContain('one of several');
  });

  it('names a bus, labels an instance and adds off-rack gear', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockResolvedValue({ id: 99 });
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  it('corrects an instance\'s manufacturer and module name, refusing an empty one', async () => {
    api.get.mockResolvedValue(richPatch);
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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

  it('declares a connection point on gear the patch invented', async () => {
    api.get.mockResolvedValue(richPatch);
    api.post.mockResolvedValue({ id: 91 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

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
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([path]) => path === '/api/patches/7')).toHaveLength(1);
  });

  it('shows why a link could not be removed', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(richPatch);
    api.delete.mockRejectedValue(new Error('link is gone already'));
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('gone already');
  });
});

// A patch built from a system spans several racks, and then which case a
// module stands in is part of knowing which module it is.
describe('PatchDetailView system patches', () => {
  const systemPatch = {
    id: 8,
    name: 'Whole studio',
    description: null,
    rack_id: null,
    rack_name: 'studio',
    system_id: 4,
    system_name: 'studio',
    created_at: '2026-08-12T10:00:00Z',
    modules: [
      {
        id: 11,
        module_id: 1,
        manufacturer: 'Make Noise',
        module_name: 'Maths',
        instance: 1,
        rack_id: 10,
        rack_name: 'left case',
        live: true,
        components: [{ id: 2, type: 'output_jack', name: 'Out', values: [] }],
      },
      {
        id: 12,
        module_id: 2,
        manufacturer: 'Mutable',
        module_name: 'Plaits',
        instance: 1,
        rack_id: 11,
        rack_name: 'right case',
        live: true,
        components: [{ id: 3, type: 'input_jack', name: 'In', values: [] }],
      },
    ],
    cables: [],
    settings: [],
    normalizations: [],
    groups: [],
    links: [],
    pairs: [],
    flow: { sources: [] },
    rack_layout: [
      { id: 100, rack_id: 10, rack_name: 'left case', unit: 3, hp: 84, modules: [11] },
      { id: 101, rack_id: 11, rack_name: 'right case', unit: 3, hp: 84, modules: [12] },
    ],
  };

  it('says the patch spans a system, and names each module’s rack', async () => {
    api.get.mockResolvedValue(systemPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();

    const note = wrapper.find('[data-test="snapshot-note"]').text();
    expect(note).toContain("system 'studio'");
    expect(note).toContain('any jack on any of those racks');
    // The snapshot table gains a rack column only when there is more than one.
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('left case');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('right case');
    // …and the rack rides along in the name the diagram and cable list use,
    // which is what tells two identical modules in two cases apart.
    expect(wrapper.findComponent(PatchDiagram).props('labelFor')(systemPatch.modules[0])).toBe(
      'Make Noise Maths · left case'
    );
  });

  it('hands the diagram the rows of every rack in the system', async () => {
    api.get.mockResolvedValue(systemPatch);
    const wrapper = mount(PatchDetailView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
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
    expect(wrapper.find('[data-test="snapshot-note"]').text()).toContain("rack 'left case'");
    // No rack column: every instance stands in the same one.
    expect(wrapper.find('[data-test="patch-module-11"]').findAll('td')).toHaveLength(3);
  });
});
