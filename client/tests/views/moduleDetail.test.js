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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleDetailView from '../../src/views/ModuleDetailView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleDetailView', () => {
  const moduleResponse = mathsModule;

  it('edits the naming and HP inline', async () => {
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), hp: 20 });
    api.patch.mockResolvedValue({});
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('Make Noise Maths');
    expect(wrapper.find('[data-test="edit-naming"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-naming-button"]').trigger('click');

    const manufacturer = wrapper.find('[data-test="edit-manufacturer"]');
    const name = wrapper.find('[data-test="edit-module-name"]');
    const hp = wrapper.find('[data-test="edit-hp"]');
    expect(manufacturer.element.value).toBe('Make Noise');
    expect(name.element.value).toBe('Maths');
    expect(hp.element.value).toBe('20');

    await manufacturer.setValue('Make Noise Music');
    await name.setValue('Maths v2');
    await hp.setValue('24');
    await wrapper.find('[data-test="save-naming"]').trigger('click');
    await flushPromises();
    expect(api.patch).toHaveBeenCalledWith('/api/modules/1', {
      manufacturer: 'Make Noise Music',
      name: 'Maths v2',
      hp: '24',
    });
    expect(wrapper.find('[data-test="edit-naming"]').exists()).toBe(false);
  });

  it('edits the per-rack quantities inline, saving only the changed racks', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.put.mockResolvedValue({ ok: true, quantity: 4 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="edit-quantities"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-quantities-button"]').trigger('click');
    const main = wrapper.find('[data-test="edit-quantity-1"]');
    const travel = wrapper.find('[data-test="edit-quantity-2"]');
    expect(main.element.value).toBe('2');
    expect(travel.element.value).toBe('1');

    // A bad value blocks the save without touching the API.
    await main.setValue('0');
    await wrapper.find('[data-test="save-quantities"]').trigger('click');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="quantity-error"]').text()).toContain('main rack');

    await main.setValue('4');
    await wrapper.find('[data-test="save-quantities"]').trigger('click');
    await flushPromises();
    // Only the changed rack is saved; the untouched one is left alone.
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/api/racks/1/modules/1', { quantity: 4 });
    expect(wrapper.find('[data-test="edit-quantities"]').exists()).toBe(false);
  });

  it('reports an edit conflict and keeps the form open', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.patch.mockRejectedValue(new Error('A module named "ALM Pam" already exists'));
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="edit-naming-button"]').trigger('click');
    await wrapper.find('[data-test="save-naming"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="naming-error"]').text()).toContain('already exists');
    expect(wrapper.find('[data-test="edit-naming"]').exists()).toBe(true);

    await wrapper.find('[data-test="cancel-naming"]').trigger('click');
    expect(wrapper.find('[data-test="edit-naming"]').exists()).toBe(false);
  });

  it('queues a component re-analysis with fresh retailer product pages', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.post.mockResolvedValue({ job_id: 7 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const button = wrapper.find('[data-test="reanalyze-components"]');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.attributes('title')).toContain('Perfect Circuit');
    await button.trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/reanalyze');
    expect(wrapper.find('[data-test="reanalyze-notice"]').text()).toContain('queued');

    api.post.mockRejectedValue(new Error('Retailer product pages already exist for this module'));
    await button.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="reanalyze-error"]').text()).toContain('already exist');
  });

  it('disables the re-analysis button while a retailer product page exists', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      manuals: [
        ...moduleResponse.manuals,
        {
          id: 3,
          hash: 'c'.repeat(64),
          name: 'manual',
          original_name: 'Make_Noise_Maths_Midwest_Modular_Product_Page.pdf',
          source: 'found',
          user_id: null,
          has_text: false,
          text_pages: null,
        },
      ],
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const button = wrapper.find('[data-test="reanalyze-components"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('title')).toContain('already exist');
  });

  it('queues an analysis rebuild from the saved manual and vendor pages', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.post.mockResolvedValue({ job_id: 8 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const button = wrapper.find('[data-test="rebuild-analysis"]');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.attributes('title')).toContain('Nothing new is downloaded');
    await button.trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/analyze');
    expect(wrapper.find('[data-test="rebuild-notice"]').text()).toContain('queued');

    api.post.mockRejectedValue(new Error('This module has no manual to analyze'));
    await button.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="rebuild-error"]').text()).toContain('no manual');
  });

  // The record and the list are independent reads, and the list only changes
  // when the set of modules does — an import, a delete, a rack deleted. It
  // used to be a second round trip behind the record on every module page AND
  // after every write to one.
  it('reads the module list once for the session, not again after every write', async () => {
    const list = [{ id: 1, manufacturer: 'Make Noise', name: 'Maths', racks: [{ id: 1 }] }];
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/1' ? moduleResponse : list)
    );
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const listReads = () => api.get.mock.calls.filter((c) => c[0] === '/api/modules').length;
    expect(listReads()).toBe(1);

    // A second page over the same record asks for the record again and the
    // list not at all.
    const second = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(listReads()).toBe(1);
    expect(api.get.mock.calls.filter((c) => c[0] === '/api/modules/1').length).toBe(2);
    wrapper.unmount();
    second.unmount();
  });

  it('links to the previous and next modules in the current rack', async () => {
    currentRouteQuery = { rack: '1' };
    const list = [
      { id: 1, manufacturer: 'Make Noise', name: 'Maths', racks: [{ id: 1 }] },
      { id: 2, manufacturer: 'Mutable Instruments', name: 'Rings', racks: [{ id: 1 }] },
      { id: 3, manufacturer: 'Xaoc', name: 'Batumi', racks: [{ id: 2 }] },
    ];
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/1' ? moduleResponse : list)
    );

    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="previous-module"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="next-module"]').attributes('to')).toBe('/modules/2?rack=1');

    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/2' ? { ...moduleResponse, id: 2 } : list)
    );
    await wrapper.setProps({ id: '2' });
    await flushPromises();
    expect(wrapper.find('[data-test="previous-module"]').attributes('to')).toBe(
      '/modules/1?rack=1'
    );
    expect(wrapper.find('[data-test="next-module"]').exists()).toBe(false);
  });

  it('uploads a front-panel picture, with the width when one is given', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ panel: null, job_id: 7 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // No panel yet, so the section says so and still offers the upload.
    expect(wrapper.find('[data-test="no-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="panel-upload"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remove-panel"]').exists()).toBe(false);

    await wrapper.find('[data-test="panel-hp"]').setValue('20');
    const file = new File(['\x89PNG fake'], 'maths-front.png', { type: 'image/png' });
    await wrapper.vm.uploadPanel(file);
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel', {
      filename: 'maths-front.png',
      data_base64: expect.any(String),
      hp: '20',
    });
  });

  it('prepopulates the panel import width from the analyzed module HP', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/1' ? { ...moduleResponse, hp: 20 } : [])
    );
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="panel-hp"]').element.value).toBe('20');

    // Moving to another module replaces an in-progress override with that
    // module's own analyzed width rather than carrying it across modules.
    await wrapper.find('[data-test="panel-hp"]').setValue('18');
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/2' ? { ...moduleResponse, id: 2, hp: 12 } : [])
    );
    await wrapper.setProps({ id: '2' });
    await flushPromises();
    expect(wrapper.find('[data-test="panel-hp"]').element.value).toBe('12');
  });

  it('downloads a front-panel picture from a URL, with the width when one is given', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ panel: null, job_id: 7 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="panel-hp"]').setValue('12');
    await wrapper.find('[data-test="panel-url"]').setValue(' https://example.com/maths.png ');
    await wrapper.find('[data-test="panel-url-submit"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel', {
      url: 'https://example.com/maths.png',
      hp: '12',
    });
  });

  it('shows the uploaded panel and removes it once confirmed', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue({
      ...moduleResponse,
      hp: 20,
      panel: {
        source: 'upload',
        source_url: null,
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        hp: 20,
        description: 'Uploaded panel image (front.png).',
        components: [{ component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9, w: 0.06, h: 0.06 }],
      },
    });
    api.delete.mockResolvedValue({ ok: true, job_id: 9 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="module-hp"]').text()).toBe('20HP');
    expect(wrapper.find('[data-test="panel"]').text()).toContain('you uploaded');
    await wrapper.find('[data-test="remove-panel"]').trigger('click');
    await flushPromises();
    expect(dialog.confirm).toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/panel');
  });

  // Every component, not only the jacks: the front panel page is where a
  // marker is put right, and a knob's marker is as wrong as a jack's.
  it('lists every component beside the plate, whatever kind it is', async () => {
    api.get.mockResolvedValue({
      ...structuredClone(moduleResponse),
      panel: {
        source: 'image',
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 }],
      },
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const rows = wrapper.find('[data-test="panel-jacks"]').text();
    expect(rows).toContain('Signal In');
    expect(rows).toContain('EOR');
    expect(rows).toContain('Rise');
    expect(wrapper.find('[data-test="arrange-component-3"]').exists()).toBe(true);
  });

  // A panel of a hundred markers is a curtain of them, and the key under it
  // is where "just the jacks, please" is asked.
  it('filters the markers to the types pressed in the key', async () => {
    api.get.mockResolvedValue({
      ...structuredClone(moduleResponse),
      panel: {
        source: 'image',
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        components: [
          { id: 5, component_id: 1, name: 'Signal In', type: 'input_jack', shape: 'jack', x: 0.5, y: 0.9 },
          { id: 6, component_id: 2, name: 'EOR', type: 'output_jack', shape: 'jack', x: 0.5, y: 0.7 },
          { id: 7, component_id: 3, name: 'Rise', type: 'knob', shape: 'knob', x: 0.5, y: 0.3 },
        ],
      },
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const markers = () => wrapper.findAll('[data-test="module-panel-svg"] g').length;
    expect(markers()).toBe(3);

    await wrapper.find('[data-test="legend-knob"]').trigger('click');
    expect(markers()).toBe(1);
    // Several at once, each its own toggle.
    await wrapper.find('[data-test="legend-input_jack"]').trigger('click');
    expect(markers()).toBe(2);
    // And pressing one again takes only that one back off.
    await wrapper.find('[data-test="legend-knob"]').trigger('click');
    expect(markers()).toBe(1);
    await wrapper.find('[data-test="legend-input_jack"]').trigger('click');
    expect(markers()).toBe(3);
  });

  // A marker whose component_id is null is drawn on the plate, is in none of
  // the lists, and is the same violet an output jack is drawn in — so it
  // reads as an output jack that has gone missing.
  it('offers to tidy the markers that name no component', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [
        { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 },
        { id: 6, component_id: null, name: 'Rise (knob)', shape: 'other', x: 0.2, y: 0.2 },
      ],
    };
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), panel });
    api.post.mockResolvedValue({ orphans: 1, linked: 1, removed: 0, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="panel-relink"]').text()).toContain('1 stray marker');
    await wrapper.find('[data-test="panel-relink"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/relink');
    expect(wrapper.find('[data-test="panel-status"]').text()).toContain('back on their component');
  });

  // The panel's markers are worked out from a photograph and are right most of
  // the time. This is the rest of the time.
  it('saves a marker dragged onto the hardware it names', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      hp: 8,
      components: [
        { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', description: 'The input.', x: 0.5, y: 0.9 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const moved = { ...panel, components: [{ ...panel.components[0], y: 0.4 }] };
    api.patch.mockResolvedValue({ panel: moved });

    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const svg = wrapper.find('[data-test="module-panel-svg"]');
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 500 });
    await wrapper.find('.marker').trigger('pointerdown', { clientX: 50, clientY: 450 });
    await svg.trigger('pointermove', { clientX: 40, clientY: 200 });
    await svg.trigger('pointerup');
    await flushPromises();

    expect(api.patch).toHaveBeenCalledWith('/api/modules/1/panel/components/5', {
      x: 0.4,
      y: 0.4,
    });
    // The panel that comes back is what the marker settles on.
    expect(wrapper.find('[data-test="panel-status"]').text()).toContain('Signal In');
    expect(wrapper.find('.marker').attributes('cy')).toBe(String(0.4 * 560));
  });

  it('keeps Trim panel beside the re-analyze buttons', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // Every module-wide action is in one row at the top of the page — not
    // buried inside the Front panel section.
    const row = wrapper.find('[data-test="rebuild-analysis"]').element.parentElement;
    const button = wrapper.find('[data-test="panel-trim"]');
    expect(button.exists()).toBe(true);
    expect(button.element.parentElement).toBe(row);
    // Arranging IS done here: the plate is on this page, and the jacks are
    // listed beside it so a marker can be put right where it is drawn.
    expect(wrapper.find('[data-test="arrange-component-1"]').exists()).toBe(true);
    // Nothing is being arranged until one is picked.
    expect(wrapper.find('[data-test="panel-disable-arranging"]').exists()).toBe(false);
  });

  it('shows the summary and which racks hold the module', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="summary"]').text()).toContain('dual function generator');
    expect(wrapper.find('[data-test="racks"]').text()).toContain('main rack (×2), travel case (×1)');
    // The components themselves are listed on their own page.
    expect(wrapper.find('[data-test="group-input_jack"]').exists()).toBe(false);
  });

  // The page a marker is wrong on is the page showing the plate, so clicking
  // one arranges that component here rather than sending the reader away.
  it('arranges the component behind a marker when it is clicked', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // A press that never moves is a click, not a drag.
    await wrapper.find('[data-test="panel-marker-1"]').trigger('pointerdown', {
      clientX: 10,
      clientY: 10,
    });
    await wrapper.find('[data-test="module-panel-svg"]').trigger('pointerup');
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Signal In');
  });

  // Both halves of the same toggle: the row beside the picture and the marker
  // on it pick the same component, and picking it again puts the panel back.
  it('arranges a jack from the list beside the plate, and stops when told', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="arrange-component-1"]').text()).toBe('Arranging');
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Signal In');

    await wrapper.find('[data-test="panel-disable-arranging"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').exists()).toBe(false);
  });

  it('trims the panel picture and keeps the markers', async () => {
    const panel = {
      source: 'upload',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.5 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    // The server hands back the cut-down picture: new bytes, plate-sized,
    // nothing left to crop, and every marker re-based onto it.
    const trimmed = {
      ...panel,
      url: '/api/panels/def.png',
      width: 200,
      height: 960,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      trimmed: true,
    };
    api.post.mockResolvedValue({ panel: trimmed });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="panel-trim"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/trim');
    expect(wrapper.find('[data-test="panel-status"]').text()).toContain('front plate');
    // The marker survives the cut, re-based onto the smaller picture.
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(true);
    // There is no backdrop left to take off, so it cannot be pressed again.
    const button = wrapper.find('[data-test="panel-trim"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Panel trimmed');
  });

  it('offers no trim on a panel the app drew itself', async () => {
    const panel = {
      source: 'generated',
      url: '/api/panels/abc.svg',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="panel-trim"]').exists()).toBe(false);
  });

  it('puts a marker back where it was when the save fails', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      hp: 8,
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    api.patch.mockRejectedValue(new Error('nope'));

    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const svg = wrapper.find('[data-test="module-panel-svg"]');
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 500 });
    await wrapper.find('.marker').trigger('pointerdown', { clientX: 50, clientY: 450 });
    await svg.trigger('pointermove', { clientX: 40, clientY: 200 });
    await svg.trigger('pointerup');
    await flushPromises();

    expect(wrapper.find('[data-test="panel-error"]').text()).toContain('nope');
    expect(wrapper.find('.marker').attributes('cy')).toBe(String(0.9 * 560));
  });

  it('leaves the picture alone when the removal is declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue({
      ...moduleResponse,
      panel: {
        source: 'upload',
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        hp: null,
        components: [],
      },
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="remove-panel"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
