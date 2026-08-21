import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

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
import PatchConfigView from '../../src/views/PatchConfigView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchConfigView', () => {
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
  // Everything on this page is gated behind a question, and a declined one
  // acts on nothing.
  it('asks before removing a setting or an instance', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

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

  it('renders the settings and the module snapshot, and points back at the patch', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    expect(wrapper.find('[data-test="setting-31"]').text()).toContain('Rise');
    // A module deleted since the snapshot still shows, marked as gone.
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('no longer in your system');
    expect(wrapper.find('[data-test="back-to-patch"]').attributes('to')).toBe('/patches/7');
  });




  // Which way a jack runs is a fact about the MODULE, so correcting it from
  // the picture writes to the module and every patch drawing it follows.

  // Typing into a picker, then taking the highlighted match with Enter.
  async function pick(wrapper, test, text) {
    const input = wrapper.find(`[data-test="${test}"]`);
    await input.trigger('focus');
    await input.setValue(text);
    await input.trigger('keydown', { key: 'Enter' });
    return input;
  }











  it('renders the signal flow as an indented tree with source, merge and cycle badges', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const overridden = wrapper.find('[data-test="normalled-11-41"]');
    expect(overridden.text()).toContain('Signal In');
    expect(overridden.text()).toContain('internal oscillator');
    expect(overridden.text()).toContain('overridden');

    const active = wrapper.find('[data-test="normalled-13-42"]');
    expect(active.text()).toContain('active');
    expect(active.text()).toContain('receives EOR from Make Noise Maths (via M1)');
  });


  it('offers enum options as a dropdown and ranges as numbers when dialing in a module', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockResolvedValue({ id: 32 });
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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


describe('PatchConfigView beyond the rack', () => {
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('LXR (snare voice)');
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('Rhythm');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('off-rack gear');
    expect(wrapper.find('[data-test="link-81"]').text()).toContain('bridge');
    expect(wrapper.find('[data-test="link-81"]').text()).toContain('1↔1');
    // The declared connection point of the off-rack gear is listed.
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('MIDI OUT');
    expect(wrapper.find('[data-test="declared-12"]').text()).toContain('midi din');
  });


  it('flags bridged, conditional, optional and cut-short paths in the flow', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    const row = wrapper.find('[data-test="normalled-11-41"]');
    expect(row.text()).toContain('overridden');
    expect(row.text()).toContain('a cable is patched out of L');
    expect(row.text()).toContain('one of several');
  });

  it('corrects an instance\'s manufacturer and module name, refusing an empty one', async () => {
    api.get.mockResolvedValue(richPatch);
    api.put.mockResolvedValue({});
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchConfigView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    await wrapper.find('[data-test="delete-link-81"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('gone already');
  });
});

// A patch built from a system spans several racks, and then which case a
// module stands in is part of knowing which module it is.
describe('PatchConfigView system patches', () => {
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
    const wrapper = mount(PatchConfigView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // The snapshot table gains a rack column only when there is more than one.
    expect(wrapper.find('[data-test="patch-module-11"]').text()).toContain('left case');
    expect(wrapper.find('[data-test="patch-module-12"]').text()).toContain('right case');
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
    const wrapper = mount(PatchConfigView, { props: { id: '8' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    // No rack column: every instance stands in the same one.
    expect(wrapper.find('[data-test="patch-module-11"]').findAll('td')).toHaveLength(3);
  });
});
