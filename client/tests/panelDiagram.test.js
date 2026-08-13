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
  cablePath,
  layoutDiagram,
  panelWidth,
  spareJacks,
  usedModules,
} from '../src/panelLayout.js';
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

describe('panel layout geometry', () => {
  it('sizes a panel from the visible part of its image', () => {
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
  // inventing a spot for the rest would put a marker over the wrong hole.
  it('puts a jack the panel could not place in the strip below it', () => {
    const [maths] = modules();
    maths.components.push({ id: 9, type: 'output_jack', name: 'UNITY' });
    expect(spareJacks(maths).map((c) => c.id)).toEqual([9]);
    const { anchors, panels } = layoutDiagram([maths]);
    const spare = anchors.get('11:9');
    expect(spare.on_panel).toBe(false);
    expect(spare.y).toBeGreaterThan(panels[0].y + panels[0].height);
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

  it('draws a cable as a curve that sags between its ends', () => {
    const d = cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(d).toMatch(/^M 0 0 C /);
    const [, sag] = d.match(/C 0 (\d+(?:\.\d+)?)/);
    expect(Number(sag)).toBeGreaterThan(0);
    // Successive cables between the same points are nudged apart.
    expect(cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 1)).not.toBe(d);
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
  const mountDiagram = (props = {}) =>
    mount(PatchDiagram, {
      props: { modules: modules(), cables: [cable()], ...props },
      global: testGlobal(),
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
    expect(wrapper.text()).not.toContain('A-180');
    await wrapper.find('[data-test="diagram-show-all"]').setValue(true);
    expect(wrapper.text()).toContain('A-180');
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
