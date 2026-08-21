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
    useRoute: () => ({ query: currentRouteQuery, path: '/patches/7/flow' }),
  };
});

import { api } from '../../src/api.js';
import PatchFlowView from '../../src/views/PatchFlowView.vue';
import { krellPatch, richPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchFlowView', () => {
  const patchResponse = krellPatch;

  it('renders the signal flow as an indented tree with source, merge and cycle badges', async () => {
    api.get.mockResolvedValue(patchResponse);
    const wrapper = mount(PatchFlowView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchFlowView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchFlowView, { props: { id: '7' }, global: testGlobal() });
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
});

describe('PatchFlowView beyond the rack', () => {
  it('flags bridged, conditional, optional and cut-short paths in the flow', async () => {
    api.get.mockResolvedValue(richPatch);
    const wrapper = mount(PatchFlowView, { props: { id: '7' }, global: testGlobal() });
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
    const wrapper = mount(PatchFlowView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    const row = wrapper.find('[data-test="normalled-11-41"]');
    expect(row.text()).toContain('overridden');
    expect(row.text()).toContain('a cable is patched out of L');
    expect(row.text()).toContain('one of several');
  });
});
