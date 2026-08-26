import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { clearToasts, toastState } from '../../src/toast.js';
import PatchDetailView from '../../src/views/PatchDetailView.vue';
import PatchDiagram from '../../src/components/PatchDiagram.vue';
import { componentColor } from '../../src/componentTypes.js';
import {
  krellPatch,
  switchPatch,
  systemPatch as systemPatchFixture,
} from '../patchFixtures.js';

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
    expect(wrapper.find('[data-test="ask-about-patch"]').attributes('to')).toBe('/patches/7/questions');
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

  // The cable the SERVER made is put straight into the picture: re-reading a
  // whole studio's patch is a second of work and two megabytes for one row,
  // and it is what made a patched cable slow to appear.
  it('draws the cable it was given back without re-reading the patch', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22, from_patch_module_id: 11, from_component_id: 2, to_patch_module_id: 11, to_component_id: 1, paired_cable: null });
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
    const cables = wrapper.findComponent(PatchDiagram).props('cables');
    expect(cables.map((c) => c.id)).toContain(22);
    // The one field the payload does not carry is not smuggled into it.
    expect(cables.find((c) => c.id === 22)).not.toHaveProperty('paired_cable');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // Both halves of a stereo pair are one decision, and the server plugs the
  // second cable itself — so both come back and both are drawn.
  it('draws the other half of a pair the server plugged with it', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({ id: 22, paired_cable: { id: 23 } });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', { from_patch_module_id: 11, from_component_id: 2, to_patch_module_id: 11, to_component_id: 1, pair: true });
    await flushPromises();
    expect(wrapper.findComponent(PatchDiagram).props('cables').map((c) => c.id)).toEqual(
      expect.arrayContaining([22, 23])
    );
  });

  // Moving a plug is an unplug and a re-plug in one validated request, and
  // the row the server made swaps in for the old one with no second read.
  it('moves a cable in one request and swaps in the row the server made', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.post.mockResolvedValue({
      id: 30,
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 12,
      to_component_id: 5,
    });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('move', {
      cable: { id: 21 },
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 12,
      to_component_id: 5,
    });
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/7/cables/21/move', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 12,
      to_component_id: 5,
    });
    const ids = wrapper.findComponent(PatchDiagram).props('cables').map((c) => c.id);
    expect(ids).toContain(30);
    expect(ids).not.toContain(21);
    expect(api.get).toHaveBeenCalledTimes(1);
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
    // Pulled out of the picture on the spot, again with no second read.
    expect(wrapper.findComponent(PatchDiagram).props('cables').map((c) => c.id)).not.toContain(21);
    expect(api.get).toHaveBeenCalledTimes(1);
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

  // A menu parameter dialed in from the picture is the same PUT the settings
  // page makes — and unlike a cable, a setting can flip a conditional
  // normalled connection or a switched mult, so the patch is re-read.
  it('records a menu parameter picked from the module menu', async () => {
    const withMenu = structuredClone(patchResponse);
    withMenu.modules.find((m) => m.id === 11).parameters = [
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
        description: null,
      },
    ];
    api.get.mockResolvedValue(withMenu);
    api.put.mockResolvedValue({ id: 34 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    // Alt- or right-click on the panel, anywhere that is not a jack or a
    // cable, opens the module's menu at the pointer.
    await wrapper.find('g[data-pm="11"] .panel-frame').trigger('contextmenu');
    const entry = wrapper.find('[data-test="diagram-menu-parameter-101"]');
    expect(entry.text()).toContain('EOR · Clock division');
    await entry.trigger('click');
    await wrapper.find('[data-test="diagram-menu-option-2"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/settings', {
      patch_module_id: 11,
      parameter_id: 101,
      value: 'x2',
    });
    // The page re-reads the patch: a setting can change what the picture says.
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("records a control's position the diagram asks to set", async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockResolvedValue({ id: 35 });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('setting', {
      patch_module_id: 11,
      component_id: 3,
      value: '5',
    });
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/settings', {
      patch_module_id: 11,
      component_id: 3,
      value: '5',
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  // api.js has already raised the toast for a refused setting; the page has
  // nothing to add and nothing to re-read.
  it('shrugs off a setting the server refuses', async () => {
    api.get.mockResolvedValue(patchResponse);
    api.put.mockRejectedValue(new Error('that module is not part of this patch'));
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    wrapper.findComponent(PatchDiagram).vm.$emit('setting', {
      patch_module_id: 11,
      component_id: 3,
      value: '5',
    });
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
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

// Plugging a unipolar CV output into a bipolar CV input (or the reverse) is a
// cable nothing refuses — so the page says it as a warning over the picture,
// one that stays up until dismissed, rather than as an error that undoes
// anything.
describe('PatchDetailView polarity warnings', () => {
  // Maths EOR is a 0–10V gate-ish output; Signal In takes CV either side of
  // zero. The fixture leaves polarity unstated, as most payloads do, so the
  // mismatched pair is set up here.
  const withPolarity = () => {
    const p = structuredClone(krellPatch);
    const maths = p.modules.find((m) => m.id === 11).components;
    maths.find((c) => c.id === 2).polarity = 'unipolar'; // EOR
    maths.find((c) => c.id === 1).polarity = 'bipolar'; // Signal In
    return p;
  };
  const ends = {
    from_patch_module_id: 11,
    from_component_id: 2,
    to_patch_module_id: 11,
    to_component_id: 1,
  };

  beforeEach(() => clearToasts());
  afterEach(() => clearToasts());

  it('warns, until dismissed by hand, when a unipolar output lands in a bipolar input', async () => {
    api.get.mockResolvedValue(withPolarity());
    api.post.mockResolvedValue({ id: 22, ...ends, paired_cable: null });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', ends);
    await flushPromises();

    // The cable is still plugged — the warning is advice, not a refusal.
    expect(wrapper.findComponent(PatchDiagram).props('cables').map((c) => c.id)).toContain(22);
    expect(toastState.items).toHaveLength(1);
    expect(toastState.items[0].kind).toBe('warning');
    expect(toastState.items[0].title).toBe('Polarity mismatch');
    expect(toastState.items[0].message).toContain('Make Noise Maths EOR');
    expect(toastState.items[0].message).toContain('bipolar input Make Noise Maths Signal In');
    // No clock on it: it stands until the user takes it down.
    expect(toastState.items[0].timeout).toBeFalsy();
  });

  it('says which half of a bipolar signal a unipolar input will lose', async () => {
    const patch = withPolarity();
    const maths = patch.modules.find((m) => m.id === 11).components;
    maths.find((c) => c.id === 2).polarity = 'bipolar';
    maths.find((c) => c.id === 1).polarity = 'unipolar';
    api.get.mockResolvedValue(patch);
    api.post.mockResolvedValue({ id: 22, ...ends, paired_cable: null });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', ends);
    await flushPromises();

    expect(toastState.items).toHaveLength(1);
    expect(toastState.items[0].message).toContain('below 0V is clipped or ignored');
  });

  it('warns when moving a plug lands a cable on a mismatched jack', async () => {
    api.get.mockResolvedValue(withPolarity());
    api.post.mockResolvedValue({ id: 30, ...ends });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    wrapper.findComponent(PatchDiagram).vm.$emit('move', { cable: { id: 21 }, ...ends });
    await flushPromises();

    expect(toastState.items.map((item) => item.kind)).toEqual(['warning']);
  });

  it('says nothing when the polarities agree, or when either is unknown', async () => {
    // The stock fixture states no polarity at all — the common case.
    api.get.mockResolvedValue(krellPatch);
    api.post.mockResolvedValue({ id: 22, ...ends, paired_cable: null });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', ends);
    await flushPromises();
    expect(toastState.items).toHaveLength(0);

    // Both ends stated and the same is just as quiet.
    const agreeing = withPolarity();
    agreeing.modules
      .find((m) => m.id === 11)
      .components.find((c) => c.id === 1).polarity = 'unipolar';
    api.get.mockResolvedValue(agreeing);
    const again = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    again.findComponent(PatchDiagram).vm.$emit('connect', ends);
    await flushPromises();
    expect(toastState.items).toHaveLength(0);
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

// A routing switch runs ONE way, and either end of it can be the cable that
// says which. Reading only the arriving end left a common patched ONWARD —
// four steps feeding one output, the many-to-one half of what a switch is
// for — with every jack of the section still drawn as undecided.
describe('PatchDetailView switch sections', () => {
  const COLOURS = {
    input: componentColor('input_jack'),
    output: componentColor('output_jack'),
    both: componentColor('bidirectional_jack'),
  };

  async function draw(cables) {
    api.get.mockResolvedValue({ ...switchPatch, cables });
    const wrapper = mount(PatchDetailView, { props: { id: '9' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    return (pm, component) =>
      wrapper.find(`[data-test="diagram-jack-${pm}-${component}"]`).attributes('fill');
  }

  it('leaves an unpatched section bidirectional at both ends', async () => {
    const fill = await draw([]);
    expect(fill(40, 80)).toBe(COLOURS.both);
    expect(fill(40, 81)).toBe(COLOURS.both);
  });

  it('points the section common → steps when the common is fed', async () => {
    const fill = await draw([
      {
        id: 1,
        from_patch_module_id: 41,
        from_component_id: 91,
        from_component_name: 'Out',
        to_patch_module_id: 40,
        to_component_id: 80,
        to_component_name: 'I/O',
      },
    ]);
    expect(fill(40, 80)).toBe(COLOURS.input);
    for (const step of [81, 82, 83, 84]) expect(fill(40, step)).toBe(COLOURS.output);
  });

  it('points the section steps → common when the common is patched onward', async () => {
    const fill = await draw([
      {
        id: 1,
        from_patch_module_id: 40,
        from_component_id: 80,
        from_component_name: 'I/O',
        to_patch_module_id: 41,
        to_component_id: 90,
        to_component_name: 'In',
      },
    ]);
    expect(fill(40, 80)).toBe(COLOURS.output);
    for (const step of [81, 82, 83, 84]) expect(fill(40, step)).toBe(COLOURS.input);
  });

  it('points the section the same way when a step is patched onward instead', async () => {
    const fill = await draw([
      {
        id: 1,
        from_patch_module_id: 40,
        from_component_id: 82,
        from_component_name: '2',
        to_patch_module_id: 41,
        to_component_id: 90,
        to_component_name: 'In',
      },
    ]);
    expect(fill(40, 80)).toBe(COLOURS.input);
    for (const step of [81, 82, 83, 84]) expect(fill(40, step)).toBe(COLOURS.output);
  });

  it('says nothing when the section is driven at both ends', async () => {
    const fill = await draw([
      {
        id: 1,
        from_patch_module_id: 41,
        from_component_id: 91,
        from_component_name: 'Out',
        to_patch_module_id: 40,
        to_component_id: 80,
        to_component_name: 'I/O',
      },
      {
        id: 2,
        from_patch_module_id: 41,
        from_component_id: 91,
        from_component_name: 'Out',
        to_patch_module_id: 40,
        to_component_id: 81,
        to_component_name: '1',
      },
    ]);
    expect(fill(40, 80)).toBe(COLOURS.both);
    expect(fill(40, 81)).toBe(COLOURS.both);
  });
});
