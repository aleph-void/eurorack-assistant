// The patch drawn as panels and cables: the geometry, the diagram component,
// and the single-module panel figure.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let currentRouteQuery = {};
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
    useRoute: () => ({ query: currentRouteQuery }),
  };
});

import { api } from '../src/api.js';
import { dialog } from '../src/dialog.js';
import {
  PANEL_HEIGHT,
  cableColor,
  cableHitPath,
  cablePath,
  layoutDiagram,
  panelImageUrl,
  panelThumbUrl,
  panelWidth,
  spareJacks,
  usedModules,
} from '../src/panelLayout.js';
import { componentColor } from '../src/componentTypes.js';
import PatchDiagram from '../src/components/PatchDiagram.vue';
import ModulePanel from '../src/components/ModulePanel.vue';
import ModulesView from '../src/views/ModulesView.vue';

const panelFor = (components, extra = {}) => ({
  source: 'generated',
  url: '/api/panels/abc.svg',
  width: 200,
  height: 1000,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  hp: 8,
  components,
  ...extra,
});

// Two modules, one cable, everything placed.
const modules = () => [
  {
    id: 11,
    module_id: 1,
    manufacturer: 'Make Noise',
    module_name: 'Maths',
    instance: 1,
    live: true,
    components: [
      { id: 1, type: 'output_jack', name: 'EOR' },
      { id: 2, type: 'input_jack', name: 'Signal In' },
    ],
    panel: panelFor([
      { component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8, w: 0.06, h: 0.06 },
      { component_id: 2, name: 'Signal In', shape: 'jack', x: 0.7, y: 0.9, w: 0.06, h: 0.06 },
    ]),
  },
  {
    id: 12,
    module_id: 2,
    manufacturer: 'Optomix',
    module_name: 'LPG',
    instance: 1,
    live: true,
    components: [{ id: 3, type: 'input_jack', name: 'CH1 IN' }],
    panel: panelFor([
      { component_id: 3, name: 'CH1 IN', shape: 'jack', x: 0.5, y: 0.85, w: 0.06, h: 0.06 },
    ]),
  },
];

const cable = (extra = {}) => ({
  id: 21,
  from_patch_module_id: 11,
  from_component_id: 1,
  from_component_name: 'EOR',
  to_patch_module_id: 12,
  to_component_id: 3,
  to_component_name: 'CH1 IN',
  note: null,
  optional: false,
  stacked: false,
  alt_group: null,
  ...extra,
});

// The two ends of a drawn cable, read back off its `d` — 'M x y C x1 y1 x2 y2
// x3 y3', so the first pair and the last pair are where it starts and stops.
const pathEnds = (d) => {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  return { from: { x: n[0], y: n[1] }, to: { x: n[6], y: n[7] } };
};
const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('panel layout geometry', () => {
  it('sizes a panel from the HP of the module, so two widths are two widths', () => {
    // 3U is 128.5mm tall and an HP is 5.08mm, so at a 420-unit height an HP
    // is 16.6 units: the hardware's own measure, matching the rack organizer.
    expect(panelWidth({ hp: 84, panel: panelFor([]) }, 420)).toBe(1395);
    expect(panelWidth({ hp: 60, panel: panelFor([]) }, 420)).toBe(996);
    expect(panelWidth({ hp: 2, panel: panelFor([]) }, 420)).toBe(33);
    // A 1U module is a third as tall and exactly as wide as a 3U one: HP is
    // measured against the height of 3U, not against the row's own height.
    expect(panelWidth({ hp: 12, panel: panelFor([]) }, 140, 420)).toBe(199);
    // Bad data — a whole row's HP recorded on one module — is not a width.
    expect(panelWidth({ hp: 504, panel: panelFor([]) }, 420)).toBe(84);
  });

  // Only when the module's HP is unknown, and only then is a fixed ceiling
  // right: with nothing to check it against, a photograph that took in the
  // module's box would otherwise draw a panel the width of the case.
  it('falls back to the visible part of its image when the HP is unknown', () => {
    const pm = { panel: panelFor([]) };
    // 200x1000 at a 420-unit height.
    expect(panelWidth(pm, 420)).toBe(84);
    // Cropping away the background narrows it in proportion.
    const cropped = { panel: panelFor([], { crop: { x: 0.1, y: 0, w: 0.8, h: 1 } }) };
    expect(panelWidth(cropped, 420)).toBe(67);
    // ...down to a floor, so a very narrow module is still a visible strip.
    const sliver = { panel: panelFor([], { crop: { x: 0.4, y: 0, w: 0.2, h: 1 } }) };
    expect(panelWidth(sliver, 420)).toBe(54);
  });

  it('falls back to a fixed width for a module with no panel', () => {
    expect(panelWidth({ panel: null }, 420)).toBe(150);
    expect(panelWidth({ panel: { width: 0, height: 0 } }, 420)).toBe(150);
  });

  it('anchors each jack at its position on the drawn panel', () => {
    const { anchors, panels, width, height } = layoutDiagram(modules());
    expect(panels).toHaveLength(2);
    const eor = anchors.get('11:1');
    expect(eor.on_panel).toBe(true);
    expect(eor.x).toBeCloseTo(panels[0].x + 0.3 * panels[0].width);
    expect(eor.y).toBeCloseTo(panels[0].y + 0.8 * PANEL_HEIGHT);
    // The second panel sits to the right of the first.
    expect(anchors.get('12:3').x).toBeGreaterThan(eor.x);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(PANEL_HEIGHT);
  });

  // A photograph only carries the jacks the LLM could actually see on it;
  // inventing a spot for the rest would put a marker over the wrong hole, and
  // hanging them under the panel is what pushed the rows of a case apart.
  it('leaves a jack the panel could not place out of the picture', () => {
    const [maths, lpg] = modules();
    maths.components.push({ id: 9, type: 'output_jack', name: 'UNITY' });
    expect(spareJacks(maths).map((c) => c.id)).toEqual([9]);
    const { anchors, panels } = layoutDiagram([maths, lpg], { rowStarts: [1] });
    expect(anchors.get('11:9')).toBeUndefined();
    // ...so the row below still sits straight under the row above.
    expect(panels[1].y).toBe(panels[0].y + panels[0].height);
  });

  // The ribbon connector an expander's cable plugs into is behind the panel, a
  // MINI USB socket faces a computer, and an SD slot takes a card: none of
  // them is a hole anybody patches.
  it.each([
    ['an expansion header', 'ribbon', 'EXP'],
    ['a USB socket', 'usb', 'MINI USB'],
    ['a memory card slot', 'memory_card', 'SD CARD'],
  ])('keeps %s out of the picture', (_label, portKind, name) => {
    const [maths] = modules();
    maths.components.push({ id: 8, type: 'input_jack', name, port_kind: portKind });
    maths.panel.components.push({
      component_id: 8,
      name,
      shape: 'jack',
      x: 0.5,
      y: 0.1,
      w: 0.06,
      h: 0.06,
    });
    expect(spareJacks(maths).map((c) => c.id)).toEqual([]);
    const { anchors } = layoutDiagram([maths]);
    expect(anchors.get('11:8')).toBeUndefined();
    expect(anchors.get('11:1')).toBeTruthy();
  });

  it('arranges the jacks of a module with no panel inside its placeholder', () => {
    const external = {
      id: 30,
      manufacturer: '',
      module_name: 'Mixer',
      panel: null,
      components: [
        { id: 40, type: 'input_jack', name: 'L' },
        { id: 41, type: 'input_jack', name: 'R' },
      ],
    };
    const { anchors, panels } = layoutDiagram([external]);
    for (const id of [40, 41]) {
      const a = anchors.get(`30:${id}`);
      expect(a.x).toBeGreaterThanOrEqual(panels[0].x);
      expect(a.x).toBeLessThanOrEqual(panels[0].x + panels[0].width);
      expect(a.y).toBeLessThan(panels[0].y + panels[0].height);
    }
  });

  it('wraps modules onto a new row once the row is full', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      manufacturer: 'M',
      module_name: `Mod ${i}`,
      components: [],
      panel: panelFor([]),
    }));
    const { panels } = layoutDiagram(many);
    expect(new Set(panels.map((p) => p.y)).size).toBeGreaterThan(1);
  });

  // A case has no air in it: modules are screwed to the same rails, shoulder
  // to shoulder, and the row below sits straight under the row above.
  it('draws panels and rows flush against each other', () => {
    const [a, b] = modules();
    const { panels } = layoutDiagram([a, b], { rowStarts: [1] });
    expect(panels[1].y).toBe(panels[0].y + panels[0].height);
    const sameRow = layoutDiagram([a, b]);
    expect(sameRow.panels[1].x).toBe(sameRow.panels[0].x + sameRow.panels[0].width);
  });

  // A rack row is the case in front of you; folding it in two would draw a
  // rack the user does not have.
  it('never breaks a physical rack row in two', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      manufacturer: 'M',
      module_name: `Mod ${i}`,
      components: [],
      panel: panelFor([]),
    }));
    const { panels, width } = layoutDiagram(many, { rowStarts: [0], wrap: false });
    expect(new Set(panels.map((p) => p.y)).size).toBe(1);
    expect(width).toBeGreaterThan(1750);
  });

  it('reserves a band for module names only when they are drawn', () => {
    const [a] = modules();
    const bare = layoutDiagram([a]);
    const named = layoutDiagram([a], { labels: true });
    expect(named.height - bare.height).toBe(30);
    expect(named.panels[0].labelY).toBeLessThan(named.panels[0].y);
  });

  // The stored file is what the manufacturer published; the diagram draws it
  // a few hundred pixels wide.
  it('asks for a panel at the size it is drawn', () => {
    const panel = panelFor([]);
    expect(panelImageUrl({ ...panel, url: '/api/panels/abc.png' }, 300)).toBe(
      '/api/panels/abc.png?w=512'
    );
    expect(panelImageUrl({ ...panel, url: '/api/panels/abc.png' }, 512)).toBe(
      '/api/panels/abc.png?w=512'
    );
    // Wanted bigger than any variant: the file itself.
    expect(panelImageUrl({ ...panel, url: '/api/panels/abc.png' }, 3000)).toBe(
      '/api/panels/abc.png'
    );
    // A drawn panel is a vector; it scales on its own.
    expect(panelImageUrl(panel, 300)).toBe('/api/panels/abc.svg');
    // A cropped photograph carries the background the crop hides, so the
    // whole picture is bigger than the part being drawn.
    const cropped = { ...panel, url: '/api/panels/abc.png', crop: { x: 0, y: 0, w: 0.5, h: 1 } };
    expect(panelThumbUrl(cropped, 200)).toBe('/api/panels/abc.png?w=512');
  });

  it('draws a cable as a curve that sags between its ends', () => {
    const d = cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(d).toMatch(/^M 0 0 C /);
    const [, sag] = d.match(/C 0 (\d+(?:\.\d+)?)/);
    expect(Number(sag)).toBeGreaterThan(0);
    // Successive cables between the same points are nudged apart.
    expect(cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 1)).not.toBe(d);
  });

  // The handle is the same curve with the jacks cut off both ends of it.
  it('trims a cable handle clear of the jack at each end', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 200, y: 0 };
    const full = cablePath(from, to, 0);
    // Nothing to keep clear of, nothing to cut.
    expect(cableHitPath(from, to, 0, 0)).toBe(full);

    const trimmed = pathEnds(cableHitPath(from, to, 0, 14));
    expect(apart(trimmed.from, from)).toBeGreaterThan(10);
    expect(apart(trimmed.from, from)).toBeLessThan(22);
    expect(apart(trimmed.to, to)).toBeGreaterThan(10);
    expect(apart(trimmed.to, to)).toBeLessThan(22);
    // Still a curve between the two, not a straight line across the gap.
    expect(trimmed.from.x).toBeLessThan(trimmed.to.x);

    // A cable with less length than the gap asks for keeps its middle rather
    // than disappearing: something has to be left to aim at.
    const short = pathEnds(cableHitPath(from, { x: 6, y: 0 }, 0, 400));
    expect(apart(short.from, short.to)).toBeGreaterThan(0);
  });

  it('gives consecutive cables different colours', () => {
    expect(cableColor(0)).not.toBe(cableColor(1));
    expect(cableColor(0)).toBe(cableColor(8));
  });

  it('picks out the instances a cable touches', () => {
    expect(usedModules(modules(), [cable()]).map((m) => m.id)).toEqual([11, 12]);
    expect(usedModules(modules(), [])).toEqual([]);
  });
});

describe('PatchDiagram', () => {
  // The mult sections as the server resolves them onto instances: which
  // bidirectional jacks are copies of each other. On ordinary hardware that
  // is one section per group label, which is what this builds; a switched
  // multiple's sections are passed by hand where a test is about them.
  const multSections = (pm) => {
    const sections = new Map();
    for (const c of pm.components.filter((j) => j.type === 'bidirectional_jack')) {
      const label = (c.group_label || '').trim();
      const key = `${pm.id}:${label.toLowerCase()}`;
      if (!sections.has(key)) {
        sections.set(key, { key, patch_module_id: pm.id, label: label || null, jacks: [] });
      }
      sections.get(key).jacks.push({
        patch_module_id: pm.id,
        component_id: c.id,
        component_name: c.name,
      });
    }
    return [...sections.values()];
  };

  const mountDiagram = (props = {}, options = {}) =>
    mount(PatchDiagram, {
      props: { modules: modules(), cables: [cable()], ...props },
      global: testGlobal(),
      ...options,
    });

  it('draws a panel image per module and a cable between the jacks', () => {
    const wrapper = mountDiagram();
    const images = wrapper.findAll('image');
    expect(images).toHaveLength(2);
    expect(images[0].attributes('href')).toBe('/api/panels/abc.svg');
    const path = wrapper.find('[data-test="diagram-cable-21"]');
    expect(path.exists()).toBe(true);
    expect(path.attributes('d')).toMatch(/^M /);
    expect(wrapper.text()).toContain('1 cable drawn');
  });

  // Unplugging from the picture, the same gesture the rack organizer uses to
  // pull a module out of a row.
  it('emits disconnect when an interactive cable is alt- or right-clicked', async () => {
    const wrapper = mountDiagram({ interactive: true });
    const path = wrapper.find('[data-test="diagram-cable-21"]');
    await path.trigger('click', { altKey: true });
    await path.trigger('contextmenu');
    expect(wrapper.emitted('disconnect')).toHaveLength(2);
    expect(wrapper.emitted('disconnect')[0][0].id).toBe(21);
  });

  // A touch screen has no alt key and no right button: a plain tap picks the
  // cable out and the bar below the picture unplugs it, naming both ends
  // first — a cable is one curve among forty on a whole studio.
  it('unplugs a cable a plain tap picked out', async () => {
    const wrapper = mountDiagram({ interactive: true });
    expect(wrapper.find('[data-test="diagram-cable-bar"]').exists()).toBe(false);
    await wrapper.find('[data-test="diagram-cable-21"]').trigger('click');
    const bar = wrapper.find('[data-test="diagram-cable-bar"]');
    expect(bar.text()).toContain('EOR');
    expect(bar.text()).toContain('CH1 IN');
    expect(wrapper.emitted('disconnect')).toBeUndefined();

    await wrapper.find('[data-test="diagram-cable-unplug"]').trigger('click');
    expect(wrapper.emitted('disconnect')[0][0].id).toBe(21);
    expect(wrapper.find('[data-test="diagram-cable-bar"]').exists()).toBe(false);
  });

  // A cable is drawn seven pixels wide and a fingertip is nearer forty, so
  // there is a fat invisible stroke over it to aim at — one that stops short
  // of the jacks at both ends, so a press where a jack and the cable plugged
  // into it lie on top of each other answers with the jack.
  it('gives every cable a handle wide enough for a finger', async () => {
    const wrapper = mountDiagram({ interactive: true });
    const hit = wrapper.find('[data-test="diagram-cable-hit-21"]');
    const drawn = pathEnds(wrapper.find('[data-test="diagram-cable-21"]').attributes('d'));
    const handle = pathEnds(hit.attributes('d'));
    expect(apart(handle.from, drawn.from)).toBeGreaterThan(6);
    expect(apart(handle.to, drawn.to)).toBeGreaterThan(6);
    expect(hit.attributes('stroke')).toBe('transparent');
    await hit.trigger('click');
    expect(wrapper.find('[data-test="diagram-cable-bar"]').text()).toContain('EOR');

    // Nothing to unplug on a shared diagram, so nothing to aim at either.
    expect(mountDiagram().find('[data-test="diagram-cable-hit-21"]').exists()).toBe(false);
  });

  // The second tap closes the bar again rather than leaving it standing.
  it('lets a tap put a picked cable back', async () => {
    const wrapper = mountDiagram({ interactive: true });
    await wrapper.find('[data-test="diagram-cable-21"]').trigger('click');
    await wrapper.find('[data-test="diagram-cable-21"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-cable-bar"]').exists()).toBe(false);
    expect(wrapper.emitted('disconnect')).toBeUndefined();
  });

  // A shared, read-only diagram keeps the browser's own context menu.
  it('leaves a read-only cable alone', async () => {
    const wrapper = mountDiagram();
    const path = wrapper.find('[data-test="diagram-cable-21"]');
    await path.trigger('click', { altKey: true });
    await path.trigger('contextmenu');
    await path.trigger('click');
    expect(wrapper.emitted('disconnect')).toBeUndefined();
    expect(wrapper.find('[data-test="diagram-cable-bar"]').exists()).toBe(false);
  });

  it('fetches each panel at the size it is painted, and re-asks when zoomed', async () => {
    const source = modules().map((pm) => ({
      ...pm,
      panel: { ...pm.panel, url: '/api/panels/photo.png' },
    }));
    const wrapper = mountDiagram({ modules: source, interactive: true });
    const src = () => wrapper.findAll('image')[0].attributes('href');
    expect(src()).toBe('/api/panels/photo.png?w=128');
    // Zoomed right in, the same panel is worth more pixels.
    for (let i = 0; i < 8; i += 1) {
      await wrapper.find('[data-test="diagram-zoom-in"]').trigger('click');
    }
    // Not yet, though: a zoom gesture crosses several steps, and a panel
    // re-fetched at each of them is replaced before it arrives.
    expect(src()).toBe('/api/panels/photo.png?w=128');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wrapper.vm.$nextTick();
    expect(src()).toBe('/api/panels/photo.png?w=512');
  });

  it('crops the image to the front plate', () => {
    const [maths, lpg] = modules();
    maths.panel.crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.8 };
    const wrapper = mountDiagram({ modules: [maths, lpg] });
    // viewBox in image pixels: 0.25*200, 0.1*1000, 0.5*200, 0.8*1000
    const nested = wrapper.findAll('svg svg');
    expect(nested[0].attributes('viewBox')).toBe('50 100 100 800');
  });

  // A patch snapshots the whole rack; drawing all forty modules would bury
  // the four that are patched.
  it('shows only the modules the patch uses until asked for the rest', async () => {
    const spare = {
      id: 13,
      manufacturer: 'Doepfer',
      module_name: 'A-180',
      components: [],
      panel: panelFor([]),
    };
    const wrapper = mountDiagram({ modules: [...modules(), spare] });
    expect(wrapper.text()).toContain('A-180');
    await wrapper.find('[data-test="diagram-show-all"]').setValue(false);
    expect(wrapper.text()).not.toContain('A-180');
  });

  // The picture is of the case, so a patch with no cables in it yet still
  // draws the rack it was snapshotted from.
  it('draws the whole rack for a patch with no cables yet', async () => {
    const wrapper = mountDiagram({ cables: [] });
    expect(wrapper.find('[data-test="diagram-svg"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Maths');
    // Unticked, a patch with nothing patched has nothing of its own to draw.
    await wrapper.find('[data-test="diagram-show-all"]').setValue(false);
    expect(wrapper.find('[data-test="diagram-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="diagram-svg"]').exists()).toBe(false);
  });

  // A module the rack organizer never put in a row still belongs to the
  // patch. It is drawn on its own below the studio, which reads as a mistake
  // unless the picture says what it is.
  it('says which modules the rack does not place', () => {
    const [maths, lpg] = modules();
    const rackRows = [{ id: 1, rack_id: 4, rack_x: 0, rack_y: 0, unit: 3, hp: 84, modules: [11] }];
    const wrapper = mountDiagram({ modules: [maths, lpg], cables: [], rackRows });
    const note = wrapper.find('[data-test="diagram-unplaced"]').text();
    expect(note).toContain('1 module stands');
    expect(note).toContain('Optomix LPG');
    expect(note).toContain('Organize rack');

    // Nothing to say when the studio places everything.
    const placed = mountDiagram({
      modules: [maths, lpg],
      cables: [],
      rackRows: [{ ...rackRows[0], modules: [11, 12] }],
    });
    expect(placed.find('[data-test="diagram-unplaced"]').exists()).toBe(false);
  });

  // A mult's jacks are interchangeable hardware until a cable arrives: the
  // one it is plugged into is the section's input and the rest carry copies
  // out. The picture says so, in the colours of what they now are — the same
  // rule the server patches by.
  it('points a mult the way the patch has plugged it', async () => {
    const mult = {
      id: 13,
      module_id: 3,
      manufacturer: 'Doepfer',
      module_name: 'A-180',
      instance: 1,
      live: true,
      components: [
        { id: 5, type: 'bidirectional_jack', name: 'M1', group_label: 'A' },
        { id: 6, type: 'bidirectional_jack', name: 'M2', group_label: 'A' },
        { id: 7, type: 'bidirectional_jack', name: 'M3', group_label: 'A' },
        // A second section on the same panel, which this cable says nothing
        // about.
        { id: 8, type: 'bidirectional_jack', name: 'N1', group_label: 'B' },
      ],
      panel: panelFor([
        { component_id: 5, name: 'M1', shape: 'jack', x: 0.2, y: 0.2, w: 0.06, h: 0.06 },
        { component_id: 6, name: 'M2', shape: 'jack', x: 0.2, y: 0.4, w: 0.06, h: 0.06 },
        { component_id: 7, name: 'M3', shape: 'jack', x: 0.2, y: 0.6, w: 0.06, h: 0.06 },
        { component_id: 8, name: 'N1', shape: 'jack', x: 0.6, y: 0.2, w: 0.06, h: 0.06 },
      ]),
    };
    const into = cable({ id: 22, to_patch_module_id: 13, to_component_id: 5, to_component_name: 'M1' });
    const wrapper = mountDiagram({
      modules: [...modules(), mult],
      cables: [into],
      mults: multSections(mult),
      interactive: true,
    });
    const fillOf = (id) => wrapper.find(`[data-test="diagram-jack-13-${id}"]`).attributes('fill');

    expect(fillOf(5)).toBe(componentColor('input_jack'));
    expect(fillOf(6)).toBe(componentColor('output_jack'));
    expect(fillOf(7)).toBe(componentColor('output_jack'));
    // The other section is untouched: nothing is plugged into it.
    expect(fillOf(8)).toBe(componentColor('bidirectional_jack'));

    // And the picture offers the same cables the server would accept: a copy
    // may be dragged out of a sibling, never out of the jack being fed.
    expect(wrapper.find('[data-test="diagram-jack-13-6"]').classes()).toContain('patchable');
    expect(wrapper.find('[data-test="diagram-jack-13-5"]').classes()).not.toContain('patchable');

    // Unplug it and the section goes back to being interchangeable.
    await wrapper.setProps({ cables: [] });
    expect(fillOf(5)).toBe(componentColor('bidirectional_jack'));
    expect(fillOf(6)).toBe(componentColor('bidirectional_jack'));
  });

  // A Doepfer A-182-1 puts each jack on one of two buses with a toggle beside
  // it, and until the patch records that toggle a jack MIGHT be on either.
  // The server resolves that into sections a jack can appear in twice, and
  // the picture points each section on its own: feeding bus A says nothing
  // about the jacks that are only on bus B.
  it('points each bus of a switched multiple by itself', () => {
    const mult = {
      id: 14,
      module_id: 4,
      manufacturer: 'Doepfer',
      module_name: 'A-182-1',
      instance: 1,
      live: true,
      components: [
        { id: 5, type: 'bidirectional_jack', name: 'OUT 1', group_label: null },
        { id: 6, type: 'bidirectional_jack', name: 'OUT 2', group_label: null },
        { id: 7, type: 'bidirectional_jack', name: 'OUT 3', group_label: null },
      ],
      panel: panelFor([
        { component_id: 5, name: 'OUT 1', shape: 'jack', x: 0.2, y: 0.2, w: 0.06, h: 0.06 },
        { component_id: 6, name: 'OUT 2', shape: 'jack', x: 0.2, y: 0.4, w: 0.06, h: 0.06 },
        { component_id: 7, name: 'OUT 3', shape: 'jack', x: 0.2, y: 0.6, w: 0.06, h: 0.06 },
      ]),
    };
    const jackRow = (id, name) => ({ patch_module_id: 14, component_id: id, component_name: name });
    // OUT 1 and OUT 2 on bus 1; OUT 2 is also on bus 2 with OUT 3, because
    // its toggle is not recorded and it may yet be on either.
    const mults = [
      { key: '14:1', patch_module_id: 14, label: '1', jacks: [jackRow(5, 'OUT 1'), jackRow(6, 'OUT 2')] },
      { key: '14:2', patch_module_id: 14, label: '2', jacks: [jackRow(6, 'OUT 2'), jackRow(7, 'OUT 3')] },
    ];
    const into = cable({ id: 23, to_patch_module_id: 14, to_component_id: 5, to_component_name: 'OUT 1' });
    const wrapper = mountDiagram({ modules: [...modules(), mult], cables: [into], mults });
    const fillOf = (id) => wrapper.find(`[data-test="diagram-jack-14-${id}"]`).attributes('fill');

    expect(fillOf(5)).toBe(componentColor('input_jack'));
    expect(fillOf(6)).toBe(componentColor('output_jack'));
    // Bus 2 has no input, so OUT 3 is still whatever the patch makes of it.
    expect(fillOf(7)).toBe(componentColor('bidirectional_jack'));
  });

  // A routing switch is NOT a mult: it selects one of its steps rather than
  // copying to all of them. So cabling one step of a quad sequential switch
  // says the whole section runs many-to-one — every step is an input, and the
  // common is where the selected one comes out.
  it('points a routing switch by the section, not jack by jack', async () => {
    const seq = {
      id: 14,
      module_id: 4,
      manufacturer: 'Doepfer',
      module_name: 'A-151',
      instance: 1,
      live: true,
      components: [
        { id: 40, type: 'bidirectional_jack', name: 'Out' },
        { id: 41, type: 'bidirectional_jack', name: '1' },
        { id: 42, type: 'bidirectional_jack', name: '2' },
        { id: 43, type: 'bidirectional_jack', name: '3' },
        { id: 44, type: 'bidirectional_jack', name: '4' },
      ],
      panel: panelFor([
        { component_id: 40, name: 'Out', shape: 'jack', x: 0.5, y: 0.1, w: 0.06, h: 0.06 },
        { component_id: 41, name: '1', shape: 'jack', x: 0.5, y: 0.3, w: 0.06, h: 0.06 },
        { component_id: 42, name: '2', shape: 'jack', x: 0.5, y: 0.45, w: 0.06, h: 0.06 },
        { component_id: 43, name: '3', shape: 'jack', x: 0.5, y: 0.6, w: 0.06, h: 0.06 },
        { component_id: 44, name: '4', shape: 'jack', x: 0.5, y: 0.75, w: 0.06, h: 0.06 },
      ]),
    };
    const switches = [
      {
        id: 1,
        patch_module_id: 14,
        name: 'Sequential switch',
        common_patch_module_id: 14,
        common_component_id: 40,
        steps: [41, 42, 43, 44].map((component_id) => ({ patch_module_id: 14, component_id })),
      },
    ];
    const intoStep = cable({ id: 23, to_patch_module_id: 14, to_component_id: 41, to_component_name: '1' });
    const wrapper = mountDiagram({
      modules: [...modules(), seq],
      cables: [intoStep],
      switches,
      interactive: true,
    });
    const fillOf = (id) => wrapper.find(`[data-test="diagram-jack-14-${id}"]`).attributes('fill');

    // The other three steps are the alternative SOURCES, not copies of the
    // one being fed: they take cables too, and the common carries the
    // selection out.
    expect(fillOf(41)).toBe(componentColor('input_jack'));
    expect(fillOf(42)).toBe(componentColor('input_jack'));
    expect(fillOf(43)).toBe(componentColor('input_jack'));
    expect(fillOf(44)).toBe(componentColor('input_jack'));
    expect(fillOf(40)).toBe(componentColor('output_jack'));
    // ...and the picture offers exactly those cables: out of the common,
    // into the steps.
    expect(wrapper.find('[data-test="diagram-jack-14-40"]').classes()).toContain('patchable');
    expect(wrapper.find('[data-test="diagram-jack-14-42"]').classes()).not.toContain('patchable');

    // Cabled into the common instead, the same section runs the other way.
    const intoCommon = cable({
      id: 24,
      to_patch_module_id: 14,
      to_component_id: 40,
      to_component_name: 'Out',
    });
    await wrapper.setProps({ cables: [intoCommon] });
    expect(fillOf(40)).toBe(componentColor('input_jack'));
    expect(fillOf(41)).toBe(componentColor('output_jack'));
    expect(fillOf(44)).toBe(componentColor('output_jack'));

    // Nothing patched: the section says nothing about which way it runs.
    await wrapper.setProps({ cables: [] });
    expect(fillOf(40)).toBe(componentColor('bidirectional_jack'));
    expect(fillOf(41)).toBe(componentColor('bidirectional_jack'));
  });

  // Patching is close work on a picture wider than the page: the diagram can
  // take the whole display, and refits itself to what it is given.
  it('fills the screen on request, and comes back out again', async () => {
    const wrapper = mountDiagram({}, { attachTo: document.body });
    const panel = wrapper.find('[data-test="diagram"]').element;
    const request = vi.fn(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: panel, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exit = vi.fn(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    panel.requestFullscreen = request;
    document.exitFullscreen = exit;

    const button = () => wrapper.find('[data-test="diagram-fullscreen"]');
    expect(button().text()).toBe('Full screen');
    await button().trigger('click');
    expect(request).toHaveBeenCalled();
    await wrapper.vm.$nextTick();
    expect(button().text()).toBe('Exit full screen');

    await button().trigger('click');
    expect(exit).toHaveBeenCalled();
    await wrapper.vm.$nextTick();
    expect(button().text()).toBe('Full screen');
    wrapper.unmount();
  });

  it('names each module with the label the patch uses', () => {
    const wrapper = mountDiagram({ labelFor: (pm) => `${pm.module_name} (voice)` });
    expect(wrapper.text()).toContain('Maths (voice)');
  });

  it('says how many cables it could not draw', () => {
    const wrapper = mountDiagram({
      cables: [cable(), cable({ id: 22, to_component_id: null })],
    });
    expect(wrapper.find('[data-test="diagram-undrawn"]').text()).toContain('1 cable is not drawn');
  });

  it('dashes an optional cable', () => {
    const wrapper = mountDiagram({ cables: [cable({ optional: true })] });
    expect(wrapper.find('[data-test="diagram-cable-21"]').classes()).toContain('optional');
  });

  it('zooms the picture in and out without moving a jack', async () => {
    const wrapper = mountDiagram({ interactive: true });
    const svg = wrapper.find('[data-test="diagram-svg"]');
    const at = () => Number(svg.attributes('style').match(/width:\s*(\d+)px/)[1]);
    const before = at();
    expect(wrapper.find('[data-test="diagram-zoom-level"]').text()).toBe('100%');

    await wrapper.find('[data-test="diagram-zoom-in"]').trigger('click');
    expect(at()).toBeGreaterThan(before);
    expect(wrapper.find('[data-test="diagram-zoom-level"]').text()).toBe('125%');
    await wrapper.find('[data-test="diagram-zoom-out"]').trigger('click');
    expect(at()).toBe(before);

    // The coordinate space is untouched, so every anchor still lines up.
    const viewBox = svg.attributes('viewBox');
    await wrapper.find('[data-test="diagram-zoom-in"]').trigger('click');
    expect(svg.attributes('viewBox')).toBe(viewBox);

    await wrapper.find('[data-test="diagram-zoom-fit"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-zoom-level"]').text()).toBe('100%');
  });

  it('names every module on request', async () => {
    const wrapper = mountDiagram();
    expect(wrapper.findAll('.panel-label')).toHaveLength(0);
    // The name is still there for the pointer to find.
    expect(wrapper.text()).toContain('Maths');
    await wrapper.find('[data-test="diagram-module-names"]').setValue(true);
    expect(wrapper.findAll('.panel-label')).toHaveLength(2);
  });

  // Which way a bidirectional jack runs is the patch's business, so it is
  // neither the output violet nor the input green — and it may be either end
  // of a cable.
  it('marks a bidirectional jack in its own colour and lets it start a cable', async () => {
    const source = modules();
    source[0].components[0] = { id: 1, type: 'bidirectional_jack', name: '1' };
    const layout = layoutDiagram(source);
    const wrapper = mountDiagram({ modules: source, cables: [], interactive: true });
    await wrapper.find('[data-test="diagram-show-all"]').setValue(true);
    const marker = wrapper.find('[data-test="diagram-jack-11-1"]');
    // The type's colour is the marker's FILL — a dot rather than a hairline
    // ring, so it is still there when a whole studio is zoomed out to fit —
    // and the stroke is the dark halo it is seen against.
    expect(marker.attributes('fill')).toBe(componentColor('bidirectional_jack'));
    expect(marker.classes()).toContain('patchable');

    const svg = wrapper.find('[data-test="diagram-svg"]');
    Object.defineProperty(svg.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: layout.width, height: layout.height }),
    });
    const from = layout.anchors.get('11:1');
    const to = layout.anchors.get('12:3');
    await marker.trigger('pointerdown', { clientX: from.x, clientY: from.y, pointerId: 1 });
    await svg.trigger('pointermove', { clientX: to.x, clientY: to.y, pointerId: 1 });
    await svg.trigger('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1 });
    expect(wrapper.emitted('connect')).toEqual([
      [{ from_patch_module_id: 11, from_component_id: 1, to_patch_module_id: 12, to_component_id: 3 }],
    ]);
  });

  it('corrects which way a jack runs from the picture', async () => {
    const wrapper = mountDiagram({ interactive: true });
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    const editor = wrapper.find('[data-test="diagram-jack-editor"]');
    expect(editor.text()).toContain('EOR');
    expect(editor.text()).toContain('Make Noise Maths');

    await wrapper.find('[data-test="diagram-jack-type"]').setValue('bidirectional_jack');
    await wrapper.find('[data-test="diagram-jack-retype"]').trigger('click');
    expect(wrapper.emitted('retype')).toEqual([
      [
        {
          module_id: 1,
          patch_module_id: 11,
          component_id: 1,
          name: 'EOR',
          type: 'bidirectional_jack',
        },
      ],
    ]);
    // The editor closes with the correction made.
    expect(wrapper.find('[data-test="diagram-jack-editor"]').exists()).toBe(false);
  });

  // Patching on a phone: a drag is not available there — the picture scrolls
  // under a finger — and the two jacks of a studio-wide cable are usually not
  // on screen together anyway. So a cable is patched in two taps, with as
  // much scrolling in between as it takes.
  it('patches a cable with a tap at each end', async () => {
    const wrapper = mountDiagram({ modules: modules(), cables: [], interactive: true });
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    await wrapper.find('[data-test="diagram-jack-patch"]').trigger('click');

    // The editor gives way to the bar that says which cable is being aimed.
    expect(wrapper.find('[data-test="diagram-jack-editor"]').exists()).toBe(false);
    const bar = wrapper.find('[data-test="diagram-patch-bar"]');
    expect(bar.text()).toContain('EOR');
    expect(bar.text()).toContain('Make Noise Maths');

    // Everything the cable cannot reach fades back; the inputs stay lit.
    expect(wrapper.find('[data-test="diagram-jack-11-1"]').classes()).not.toContain('dimmed');
    expect(wrapper.find('[data-test="diagram-jack-12-3"]').classes()).not.toContain('dimmed');

    await wrapper.find('[data-test="diagram-jack-12-3"]').trigger('click');
    expect(wrapper.emitted('connect')).toEqual([
      [{ from_patch_module_id: 11, from_component_id: 1, to_patch_module_id: 12, to_component_id: 3 }],
    ]);
    expect(wrapper.find('[data-test="diagram-patch-bar"]').exists()).toBe(false);
  });

  // A mis-tap on a jack the cable cannot reach must not quietly throw the
  // half-made cable away; tapping the jack it came out of is what puts it back.
  it('holds an aimed cable until it lands or is cancelled', async () => {
    const source = modules();
    // A second output: a jack, so the picture draws it whatever the key is
    // pressed for, and nowhere a cable can END.
    source[0].components.push({ id: 8, type: 'output_jack', name: 'EOF' });
    source[0].panel.components.push({
      component_id: 8,
      name: 'EOF',
      shape: 'jack',
      x: 0.5,
      y: 0.7,
      w: 0.06,
      h: 0.06,
    });
    const wrapper = mountDiagram({ modules: source, cables: [], interactive: true });
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    await wrapper.find('[data-test="diagram-jack-patch"]').trigger('click');

    const output = wrapper.find('[data-test="diagram-jack-11-8"]');
    expect(output.classes()).toContain('dimmed');
    await output.trigger('click');
    expect(wrapper.emitted('connect')).toBeUndefined();
    expect(wrapper.find('[data-test="diagram-patch-bar"]').exists()).toBe(true);

    // Back to where it came from, and no cable made.
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-patch-bar"]').exists()).toBe(false);

    // …and Cancel does the same from the bar itself.
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    await wrapper.find('[data-test="diagram-jack-patch"]').trigger('click');
    await wrapper.find('[data-test="diagram-patch-cancel"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-patch-bar"]').exists()).toBe(false);
    expect(wrapper.emitted('connect')).toBeUndefined();
  });

  // An input jack has nothing to send, so it is not offered as one end of a
  // new cable — the same rule the drag follows.
  it('offers to patch only from a jack a cable can leave', async () => {
    const wrapper = mountDiagram({ interactive: true });
    await wrapper.find('[data-test="diagram-jack-12-3"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-jack-editor"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="diagram-jack-patch"]').exists()).toBe(false);
  });

  // The finger that would start a drag is the one that scrolls the picture:
  // claiming it would leave a phone unable to scroll past the diagram, and
  // would swallow the tap the two-tap gesture is made of.
  it('leaves a touch on a marker to the browser', async () => {
    const wrapper = mountDiagram({ modules: modules(), cables: [], interactive: true });
    const layout = layoutDiagram(modules());
    const svg = wrapper.find('[data-test="diagram-svg"]');
    Object.defineProperty(svg.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: layout.width, height: layout.height }),
    });
    const from = layout.anchors.get('11:1');
    const to = layout.anchors.get('12:3');
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('pointerdown', {
      pointerType: 'touch',
      clientX: from.x,
      clientY: from.y,
      pointerId: 1,
    });
    await svg.trigger('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1 });
    expect(wrapper.emitted('connect')).toBeUndefined();
  });

  it('leaves the jacks of a read-only diagram alone', async () => {
    const wrapper = mountDiagram();
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('click');
    expect(wrapper.find('[data-test="diagram-jack-editor"]').exists()).toBe(false);
  });

  it('has something to say when there is nothing to draw', () => {
    const wrapper = mountDiagram({ modules: [], cables: [] });
    expect(wrapper.find('[data-test="diagram-empty"]').exists()).toBe(true);
  });

  it('labels every jack on request', async () => {
    const wrapper = mountDiagram();
    expect(wrapper.findAll('.jack-label')).toHaveLength(0);
    await wrapper.find('[data-test="diagram-jack-names"]').setValue(true);
    expect(wrapper.findAll('.jack-label').length).toBe(3);
  });

  it('connects only when an output marker is dragged onto an input marker', async () => {
    const source = modules();
    // A placed knob can be put on the picture from the key, but never starts
    // a cable.
    source[0].components.push({ id: 9, type: 'knob', name: 'Rise' });
    source[0].panel.components.push({ component_id: 9, name: 'Rise', shape: 'knob', x: 0.5, y: 0.5, w: 0.06, h: 0.06 });
    const layout = layoutDiagram(source);
    const wrapper = mountDiagram({ modules: source, cables: [], interactive: true });
    await wrapper.find('[data-test="diagram-show-all"]').setValue(true);
    const svg = wrapper.find('[data-test="diagram-svg"]');
    Object.defineProperty(svg.element, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: layout.width, height: layout.height }),
    });

    const output = layout.anchors.get('11:1');
    const input = layout.anchors.get('12:3');
    await wrapper.find('[data-test="diagram-jack-11-1"]').trigger('pointerdown', {
      clientX: output.x,
      clientY: output.y,
      pointerId: 1,
    });
    await svg.trigger('pointermove', { clientX: input.x, clientY: input.y, pointerId: 1 });
    await svg.trigger('pointerup', { clientX: input.x, clientY: input.y, pointerId: 1 });
    expect(wrapper.emitted('connect')).toEqual([
      [{ from_patch_module_id: 11, from_component_id: 1, to_patch_module_id: 12, to_component_id: 3 }],
    ]);

    // The knob is only on the picture once the key is pressed for it — and
    // even then it is furniture, not a hole a cable goes in.
    await wrapper.find('[data-test="legend-knob"]').trigger('click');
    await wrapper.find('[data-test="diagram-jack-11-9"]').trigger('pointerdown', {
      clientX: output.x,
      clientY: output.y,
      pointerId: 2,
    });
    await svg.trigger('pointerup', { clientX: input.x, clientY: input.y, pointerId: 2 });
    expect(wrapper.emitted('connect')).toHaveLength(1);
  });

  // The picture is MOVED the way a map is: a studio is far wider than any
  // screen and the scroll bar is a long way from the panel being patched.
  describe('moving the picture', () => {
    // The scroll box, with a size and a scroll position jsdom will not give it.
    const scrollBox = (wrapper) => {
      const el = wrapper.find('.diagram-wrap').element;
      el.scrollLeft = 100;
      el.scrollTop = 50;
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
      return el;
    };

    it('scrolls the box under the pointer, and stops when the press ends', async () => {
      const wrapper = mountDiagram({ interactive: true });
      const el = scrollBox(wrapper);
      const wrap = wrapper.find('.diagram-wrap');

      await wrap.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 200 });
      expect(wrap.classes()).toContain('panning');
      // Dragging left and up pulls the picture the other way, like a map.
      await wrap.trigger('pointermove', { pointerId: 1, clientX: 260, clientY: 175 });
      expect(el.scrollLeft).toBe(140);
      expect(el.scrollTop).toBe(75);

      await wrap.trigger('pointerup', { pointerId: 1 });
      expect(wrap.classes()).not.toContain('panning');
      // A move after the release does nothing.
      await wrap.trigger('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
      expect(el.scrollLeft).toBe(140);
    });

    it('ignores a second pointer while one is already moving the picture', async () => {
      const wrapper = mountDiagram({ interactive: true });
      const el = scrollBox(wrapper);
      const wrap = wrapper.find('.diagram-wrap');
      await wrap.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 200 });
      await wrap.trigger('pointermove', { pointerId: 2, clientX: 0, clientY: 0 });
      expect(el.scrollLeft).toBe(100);
      // …and the wrong pointer cannot end it either.
      await wrap.trigger('pointerup', { pointerId: 2 });
      expect(wrap.classes()).toContain('panning');
    });

    it('leaves the gesture alone for a finger, a modifier or a second button', async () => {
      const wrapper = mountDiagram({ interactive: true });
      scrollBox(wrapper);
      const wrap = wrapper.find('.diagram-wrap');
      const cases = [
        // A finger already moves the picture: the box scrolls, and claiming
        // the gesture would leave a phone unable to scroll PAST the diagram.
        { pointerType: 'touch', pointerId: 1, button: 0 },
        // Alt/right-click is unplugging.
        { pointerId: 2, button: 2 },
        { pointerId: 3, button: 0, altKey: true },
        { pointerId: 4, button: 0, ctrlKey: true },
        { pointerId: 5, button: 0, metaKey: true },
      ];
      for (const event of cases) {
        await wrap.trigger('pointerdown', { clientX: 300, clientY: 200, ...event });
        expect(wrap.classes()).not.toContain('panning');
      }
    });

    it('lets a cable drag keep the gesture it already claimed', async () => {
      // pointerdown reaches the jack marker first and sets `dragging`; the
      // wrap sees the same event afterwards and must not start a pan.
      const wrapper = mountDiagram({ interactive: true, cables: [] });
      const el = scrollBox(wrapper);
      const svg = wrapper.find('[data-test="diagram-svg"]');
      Object.defineProperty(svg.element, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      });
      await wrapper
        .find('[data-test="diagram-jack-11-1"]')
        .trigger('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      await wrapper
        .find('.diagram-wrap')
        .trigger('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      expect(wrapper.find('.diagram-wrap').classes()).not.toContain('panning');
      expect(el.scrollLeft).toBe(100);
    });
  });

  // A studio is six thousand markers and all but the jacks are furniture no
  // cable can go in: the picture opens on the jacks, and the key under it is
  // where the rest of the front panel is asked for.
  describe('the key is what the picture draws', () => {
    const withControls = () => {
      const source = modules();
      source[0].components.push(
        { id: 9, type: 'knob', name: 'Rise' },
        { id: 10, type: 'toggle', name: 'Cycle' }
      );
      source[0].panel.components.push(
        { component_id: 9, name: 'Rise', shape: 'knob', x: 0.5, y: 0.5, w: 0.06, h: 0.06 },
        { component_id: 10, name: 'Cycle', shape: 'toggle', x: 0.2, y: 0.4, w: 0.06, h: 0.06 }
      );
      return source;
    };
    const markers = (wrapper) => wrapper.findAll('circle.jack-marker').length;

    it('draws the jacks and nothing else until asked', () => {
      const wrapper = mountDiagram({ modules: withControls() });
      expect(markers(wrapper)).toBe(3);
      // The key still names everything ON the picture, or there would be no
      // way to ask for the knobs back.
      expect(
        wrapper.findAll('[data-test="component-legend"] > button').map((b) => b.text())
      ).toEqual(['input jack', 'output jack', 'knob', 'toggle']);
      expect(wrapper.find('[data-test="legend-input_jack"]').attributes('aria-pressed')).toBe(
        'true'
      );
      expect(wrapper.find('[data-test="legend-knob"]').attributes('aria-pressed')).toBe('false');
    });

    it('puts another kind of thing on the picture at a press, one type at a time', async () => {
      const wrapper = mountDiagram({ modules: withControls() });
      await wrapper.find('[data-test="legend-knob"]').trigger('click');
      expect(markers(wrapper)).toBe(4);
      await wrapper.find('[data-test="legend-toggle"]').trigger('click');
      expect(markers(wrapper)).toBe(5);
      // And pressing one again takes only that one back off.
      await wrapper.find('[data-test="legend-knob"]').trigger('click');
      expect(markers(wrapper)).toBe(4);
    });

    it('takes a jack type off at a press too, down to the bare case', async () => {
      const wrapper = mountDiagram({ modules: withControls() });
      await wrapper.find('[data-test="legend-input_jack"]').trigger('click');
      expect(markers(wrapper)).toBe(1);
      await wrapper.find('[data-test="legend-output_jack"]').trigger('click');
      expect(markers(wrapper)).toBe(0);
      // The panels and the cable are still drawn — it is the case itself.
      expect(wrapper.findAll('image')).toHaveLength(2);
      expect(wrapper.find('[data-test="diagram-cable-21"]').exists()).toBe(true);
      // …and the key is still there to put them back — both input jacks.
      await wrapper.find('[data-test="legend-input_jack"]').trigger('click');
      expect(markers(wrapper)).toBe(2);
    });
  });
});

describe('ModulePanel', () => {
  it('shows the image with a marker on each placed component', () => {
    const wrapper = mount(ModulePanel, {
      props: {
        panel: panelFor(
          [{ component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8, w: 0.06, h: 0.06 }],
          { source: 'image', source_url: 'https://example.com/maths.jpg' }
        ),
      },
      global: testGlobal(),
    });
    expect(wrapper.find('image').attributes('href')).toBe('/api/panels/abc.svg');
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.text()).toContain('Front panel image');
    expect(wrapper.find('a').attributes('href')).toBe('https://example.com/maths.jpg');
  });

  it('says so when the panel is a drawing rather than a photograph', () => {
    const wrapper = mount(ModulePanel, {
      props: { panel: panelFor([]) },
      global: testGlobal(),
    });
    expect(wrapper.text()).toContain('drawing made from the module');
    expect(wrapper.text()).toContain('8HP');
  });

  // The panel picture says what each thing IS, not only where it is: every
  // component type has its own colour, and it is the same colour in the patch
  // diagram and in the rack organizer's rows.
  it('marks every component in the colour of its type', () => {
    const wrapper = mount(ModulePanel, {
      props: {
        panel: panelFor([
          { component_id: 1, name: 'EOR', shape: 'jack', type: 'output_jack', x: 0.3, y: 0.8 },
          { component_id: 2, name: 'IN', shape: 'jack', type: 'input_jack', x: 0.6, y: 0.8 },
          { component_id: 3, name: '1', shape: 'jack', type: 'bidirectional_jack', x: 0.4, y: 0.5 },
          { component_id: 4, name: 'Rise', shape: 'knob', type: 'knob', x: 0.5, y: 0.2 },
          { component_id: 5, name: 'Mode', shape: 'switch', type: 'switch', x: 0.2, y: 0.2 },
          // A placement the analysis never attached to a component: no type,
          // so it keeps the chosen marker scheme.
          { component_id: null, name: '?', shape: 'other', x: 0.9, y: 0.9 },
        ]),
      },
      global: testGlobal(),
    });
    const stroke = (id) => wrapper.find(`[data-test="panel-marker-${id}"]`).attributes('stroke');
    expect(stroke(1)).toBe(componentColor('output_jack'));
    expect(stroke(2)).toBe(componentColor('input_jack'));
    expect(stroke(3)).toBe(componentColor('bidirectional_jack'));
    expect(stroke(4)).toBe(componentColor('knob'));
    expect(stroke(5)).toBe(componentColor('switch'));
    // Every one of them a different colour, which is the whole point.
    expect(new Set([stroke(1), stroke(2), stroke(3), stroke(4), stroke(5)]).size).toBe(5);
    const untyped = wrapper.find('[data-test="panel-marker-?"]');
    expect(untyped.attributes('stroke')).toBeUndefined();
    expect(untyped.classes()).not.toContain('typed');
    // And the key beside the picture names what is on it, in order. On a
    // panel the key is also the filter, so each entry is a button.
    expect(wrapper.findAll('[data-test="component-legend"] > button').map((s) => s.text())).toEqual([
      'input jack',
      'output jack',
      'bidirectional jack',
      'knob',
      'switch',
    ]);
  });

  it('highlights the components it is asked to', () => {
    const wrapper = mount(ModulePanel, {
      props: {
        panel: panelFor([
          { component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8, w: 0.06, h: 0.06 },
          { component_id: 2, name: 'IN', shape: 'jack', x: 0.6, y: 0.8, w: 0.06, h: 0.06 },
        ]),
        highlight: [2],
      },
      global: testGlobal(),
    });
    expect(wrapper.findAll('.marker.on')).toHaveLength(1);
  });

  it('says what a component does when you rest on its marker', () => {
    const wrapper = mount(ModulePanel, {
      props: {
        panel: panelFor([
          {
            id: 7,
            component_id: 1,
            name: 'EOR',
            shape: 'jack',
            description: 'End of rise gate.',
            x: 0.3,
            y: 0.8,
          },
          { id: 8, component_id: 2, name: 'IN', shape: 'jack', x: 0.6, y: 0.8 },
        ]),
      },
      global: testGlobal(),
    });
    const titles = wrapper.findAll('title').map((t) => t.text());
    expect(titles).toContain('EOR — End of rise gate.');
    // Nothing to say about it is not a reason to say nothing at all.
    expect(titles).toContain('IN');
  });

  // Panels come in every colour, so one fixed marker colour is invisible on
  // some of them. The button is how the viewer picks one that shows up.
  describe('changing the marker colour', () => {
    const coloured = () =>
      mount(ModulePanel, {
        props: {
          panel: panelFor([
            { id: 7, component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8 },
            { id: 8, component_id: 2, name: 'IN', shape: 'jack', x: 0.6, y: 0.8 },
          ]),
          highlight: [2],
        },
        global: testGlobal(),
      });

    beforeEach(() => localStorage.clear());

    it('recolours every marker at a press, and says which colour it is on', async () => {
      const wrapper = coloured();
      const button = wrapper.find('[data-test="panel-marker-color"]');
      expect(button.text()).toContain('Violet');
      const before = wrapper.find('[data-test="module-panel-svg"]').attributes('style');

      await button.trigger('click');
      expect(button.text()).toContain('Lime');
      const after = wrapper.find('[data-test="module-panel-svg"]').attributes('style');
      expect(after).not.toBe(before);
      expect(after).toContain('--marker-ring');
      // The highlighted marker takes its colour from the same place, so it
      // moves with the rest instead of staying violet on a lime panel.
      expect(wrapper.findAll('.marker.on')).toHaveLength(1);
    });

    it('comes back round to where it started', async () => {
      const wrapper = coloured();
      const button = wrapper.find('[data-test="panel-marker-color"]');
      const names = new Set();
      for (let i = 0; i < 6; i += 1) {
        names.add(button.text());
        await button.trigger('click');
      }
      expect(names.size).toBe(6);
      expect(button.text()).toContain('Violet');
    });

    it('remembers the choice for the next panel opened', async () => {
      const first = coloured();
      await first.find('[data-test="panel-marker-color"]').trigger('click');
      expect(coloured().find('[data-test="panel-marker-color"]').text()).toContain('Lime');
    });
  });

  // The marker positions are estimates all the way down; this is how someone
  // looking at the picture overrules them.
  describe('dragging a marker onto the hardware it names', () => {
    const draggable = () =>
      mount(ModulePanel, {
        props: {
          panel: panelFor([{ id: 7, component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8 }], {
            crop: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 },
          }),
          editable: true,
        },
        global: testGlobal(),
      });

    // The SVG scales to its container, so the drag arithmetic has to use the
    // box it really occupies. jsdom measures everything as zero.
    const withBox = (wrapper, box = { left: 0, top: 0, width: 100, height: 500 }) => {
      const svg = wrapper.find('[data-test="module-panel-svg"]');
      svg.element.getBoundingClientRect = () => box;
      return svg;
    };

    it('reports where it was dropped, as a fraction of the whole image', async () => {
      const wrapper = draggable();
      const svg = withBox(wrapper);
      // Picked up where it sits, dropped in the middle of the panel.
      await wrapper.find('.marker').trigger('pointerdown', { clientX: 20, clientY: 437 });
      await svg.trigger('pointermove', { clientX: 50, clientY: 250 });
      await svg.trigger('pointerup');

      // Halfway across and halfway down the CROP, turned back into the whole
      // image the position is stored against.
      expect(wrapper.emitted('move')).toHaveLength(1);
      const [move] = wrapper.emitted('move')[0];
      expect(move).toMatchObject({ id: 7, name: 'EOR' });
      expect(move.x).toBeCloseTo(0.45);
      expect(move.y).toBeCloseTo(0.5);
    });

    it('follows the pointer before it is let go, and saves nothing until then', async () => {
      const wrapper = draggable();
      const svg = withBox(wrapper);
      const before = wrapper.find('.marker').attributes('cy');
      await wrapper.find('.marker').trigger('pointerdown', { clientX: 50, clientY: 250 });
      await svg.trigger('pointermove', { clientX: 50, clientY: 100 });
      expect(wrapper.find('.marker').attributes('cy')).not.toBe(before);
      expect(wrapper.emitted('move')).toBeUndefined();
      await svg.trigger('pointerup');
      expect(wrapper.emitted('move')).toHaveLength(1);
    });

    it('saves nothing for a click that never moved', async () => {
      const wrapper = draggable();
      const svg = withBox(wrapper);
      await wrapper.find('.marker').trigger('pointerdown');
      await svg.trigger('pointerup');
      expect(wrapper.emitted('move')).toBeUndefined();
    });

    it('leaves the markers alone when the panel is not editable', async () => {
      const wrapper = mount(ModulePanel, {
        props: {
          panel: panelFor([{ id: 7, component_id: 1, name: 'EOR', shape: 'jack', x: 0.3, y: 0.8 }]),
        },
        global: testGlobal(),
      });
      const svg = withBox(wrapper);
      await wrapper.find('.marker').trigger('pointerdown', { clientX: 50, clientY: 250 });
      await svg.trigger('pointermove', { clientX: 50, clientY: 100 });
      await svg.trigger('pointerup');
      expect(wrapper.emitted('move')).toBeUndefined();
    });
  });
});

describe('ModulesView fill in missing details', () => {
  const racks = [{ id: 1, name: 'main rack' }];
  const module = {
    id: 1,
    manufacturer: 'Make Noise',
    name: 'Maths',
    quantity: 1,
    racks: [{ id: 1, name: 'main rack', quantity: 1 }],
    manual_status: 'found',
    analysis_status: 'complete',
    panel_status: 'complete',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteQuery = {};
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/racks' ? racks : [module]));
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
  });

  it('queues the missing work without re-discovering the manuals by default', async () => {
    api.post.mockResolvedValue({
      modules: 3,
      queued: { find_manual: 0, analyze_manual: 1, panel_image: 1 },
      skipped: 0,
      complete: 1,
    });
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="reanalyze-all"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/reanalyze', {
      rack_id: undefined,
      rediscover_manuals: false,
      rebuild_panels: false,
    });
    expect(wrapper.find('[data-test="reanalyze-result"]').text()).toContain(
      'Queued 2 job(s) — 1 of 3 module(s) already complete.'
    );
  });

  it('re-discovers the manuals when the box is ticked, for the selected rack', async () => {
    currentRouteQuery = { rack: '1' };
    api.post.mockResolvedValue({
      modules: 1,
      queued: { find_manual: 1, analyze_manual: 0, panel_image: 0 },
      skipped: 0,
      complete: 0,
    });
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rediscover-manuals"]').setValue(true);
    await wrapper.find('[data-test="reanalyze-all"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/reanalyze', {
      rack_id: 1,
      rediscover_manuals: true,
      rebuild_panels: false,
    });
  });

  // Panels go stale on their own when how they are built changes, so redoing
  // every one of them is asked for separately from the rest.
  it('asks for every panel to be rebuilt when that box is ticked', async () => {
    api.post.mockResolvedValue({
      modules: 2,
      queued: { find_manual: 0, analyze_manual: 0, panel_image: 2 },
      skipped: 0,
      complete: 0,
    });
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rebuild-panels"]').setValue(true);
    await wrapper.find('[data-test="reanalyze-all"]').trigger('click');
    await flushPromises();

    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('front panel rebuilt') })
    );
    expect(api.post).toHaveBeenCalledWith('/api/modules/reanalyze', {
      rack_id: undefined,
      rediscover_manuals: false,
      rebuild_panels: true,
    });
  });

  it('does nothing when the confirmation is declined', async () => {
    dialog.confirm.mockResolvedValue(false);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="reanalyze-all"]').trigger('click');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the panel status of each module', async () => {
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="module-1"]').text()).toContain('complete');
  });
});
