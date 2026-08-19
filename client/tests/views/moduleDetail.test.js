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
import ModuleDetailView from '../../src/views/ModuleDetailView.vue';
import DocumentsSection from '../../src/components/moduledetail/DocumentsSection.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleDetailView', () => {
  const moduleResponse = {
    id: 1,
    manufacturer: 'Make Noise',
    name: 'Maths',
    manual_status: 'found',
    analysis_status: 'complete',
    summary: 'A dual function generator.',
    quantity: 3,
    racks: [
      { id: 1, name: 'main rack', quantity: 2 },
      { id: 2, name: 'travel case', quantity: 1 },
    ],
    manuals: [
      { id: 1, hash: 'a'.repeat(64), name: 'manual', original_name: 'Make_Noise_Maths_Manual.pdf', source: 'found', user_id: null, has_text: true, text_pages: 12 },
      { id: 2, hash: 'b'.repeat(64), name: 'my notes', original_name: 'my-notes.pdf', source: 'upload', user_id: 2, has_text: false, text_pages: null },
    ],
    components: [
      { id: 1, type: 'input_jack', name: 'Signal In', description: 'In', voltage_min: -10, voltage_max: 10, polarity: 'bipolar' },
      { id: 2, type: 'output_jack', name: 'EOR', description: 'Gate', voltage_min: 0, voltage_max: 10, polarity: 'unipolar' },
      { id: 3, type: 'knob', name: 'Rise', description: 'Rise time', voltage_min: null, voltage_max: null, polarity: null },
    ],
  };

  it('groups components by type and shows voltage ranges', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="summary"]').text()).toContain('dual function generator');
    expect(wrapper.find('[data-test="racks"]').text()).toContain('main rack (×2), travel case (×1)');
    expect(wrapper.find('[data-test="group-input_jack"]').text()).toContain('-10V … 10V');
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('unipolar');
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('Rise');
  });

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

  it('adds and removes controls while refreshing component lists and panel markers', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    let detail = {
      ...moduleResponse,
      components: [...moduleResponse.components],
      panel: {
        source: 'image',
        url: '/api/panels/abc.png',
        width: 400,
        height: 1200,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        components: [
          { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 },
        ],
      },
    };
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/modules/1' ? structuredClone(detail) : [])
    );
    api.post.mockImplementation(async () => {
      const component = { id: 4, type: 'knob', name: 'FREQUENCY', description: null };
      detail.components.push(component);
      detail.panel.components.push({
        id: 6,
        component_id: 4,
        name: 'FREQUENCY',
        shape: 'knob',
        x: 0.5,
        y: 0.8,
      });
      return { ...component, panel_placement_id: 6 };
    });
    api.delete.mockImplementation(async () => {
      detail.components = detail.components.filter((c) => c.id !== 4);
      detail.panel.components = detail.panel.components.filter((c) => c.component_id !== 4);
      return { ok: true };
    });

    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="add-new-input_jack"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-output_jack"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-knob"]').exists()).toBe(true);
    // Empty supported groups stay visible so their first component can be added.
    expect(wrapper.find('[data-test="add-new-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-display"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="add-new-other"]').exists()).toBe(true);

    await wrapper.find('[data-test="add-new-knob"]').trigger('click');
    await wrapper.find('[data-test="component-name"]').setValue('FREQUENCY');
    await wrapper.find('[data-test="add-form-knob"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/components', {
      name: 'FREQUENCY',
      type: 'knob',
    });
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('FREQUENCY');
    expect(wrapper.find('[data-test="panel-marker-4"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="group-knob"] .summary-count').text()).toBe('2');

    await wrapper.find('[data-test="remove-component-4"]').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/components/4');
    expect(wrapper.find('[data-test="group-knob"]').text()).not.toContain('FREQUENCY');
    expect(wrapper.find('[data-test="panel-marker-4"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-knob"] .summary-count').text()).toBe('1');
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

  it('links a document with extracted text to the reader, and says so when there is none', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    // RouterLink is stubbed in view tests, so its destination lands on the
    // rendered element as a plain attribute.
    expect(wrapper.find('[data-test="read-doc-1"]').attributes('to')).toBe(
      `/manuals/${'a'.repeat(64)}`
    );
    // The upload has not been through the extraction job yet.
    expect(wrapper.find('[data-test="read-doc-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="no-text-doc-2"]').text()).toBe('not yet');
  });

  it('records and removes routing switch sections', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    // A switch section needs a common plus two steps, so this module gets a
    // second input jack on top of the shared fixture.
    api.get.mockResolvedValue({
      ...moduleResponse,
      components: [
        ...moduleResponse.components,
        { id: 4, type: 'input_jack', name: 'Signal In 2', description: null, voltage_min: null, voltage_max: null, polarity: null },
      ],
      switches: [
        { id: 4, name: 'Section 1', common_component_id: 2, step_component_ids: [1, 4], description: null },
      ],
    });
    api.post.mockResolvedValue({ id: 5 });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="switch-4"]');
    expect(row.text()).toContain('Section 1');
    expect(row.text()).toContain('EOR');
    expect(row.text()).toContain('Signal In');

    // A section needs a common plus at least two distinct steps: selecting
    // only the common's own jack leaves too few.
    await wrapper.find('[data-test="switch-common"]').setValue('2');
    const steps = wrapper.find('[data-test="switch-steps"]');
    const stepOptions = steps.findAll('option');
    await stepOptions[1].setSelected(); // EOR — the common itself, filtered out
    expect(wrapper.find('[data-test="switch-create"]').attributes('disabled')).toBeDefined();
    await stepOptions[0].setSelected(); // Signal In
    await stepOptions[2].setSelected(); // Signal In 2
    await wrapper.find('[data-test="switch-name"]').setValue('Section 2');
    await wrapper.find('[data-test="switches"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/switches', {
      common_component_id: 2,
      step_component_ids: [1, 4],
      name: 'Section 2',
    });

    await wrapper.find('[data-test="delete-switch-4"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/switches/4');
  });

  it('records internal signal paths and marks unfed outputs as generators', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, routes: [] });
    api.post.mockResolvedValue({ id: 7 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // No route feeds EOR, so it counts as a generator.
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('generator');

    await wrapper.find('[data-test="route-input"]').setValue('1');
    await wrapper.find('[data-test="route-output"]').setValue('2');
    await wrapper.find('[data-test="routes"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/routes', {
      input_component_id: 1,
      output_component_id: 2,
    });
  });

  it('lists routes, shows what feeds an output, and removes routes', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue({
      ...moduleResponse,
      routes: [{ id: 7, input_component_id: 1, output_component_id: 2, description: 'audio path' }],
    });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="route-7"]');
    expect(row.text()).toContain('Signal In');
    expect(row.text()).toContain('EOR');
    expect(row.text()).toContain('audio path');
    expect(wrapper.find('[data-test="group-output_jack"]').text()).toContain('fed by Signal In');

    await wrapper.find('[data-test="delete-route-7"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/routes/7');
  });

  it('shows normalled connections with resolved component names', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      normalizations: [
        {
          id: 1,
          target_component_id: 1,
          source_component_id: 2,
          source_label: null,
          kind: 'output',
          description: 'EOR feeds the input by default.',
        },
        {
          id: 2,
          target_component_id: 1,
          source_component_id: null,
          source_label: 'internal oscillator',
          kind: 'internal',
          description: null,
        },
      ],
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const first = wrapper.find('[data-test="normalization-1"]');
    expect(first.text()).toContain('Signal In');
    expect(first.text()).toContain('EOR');
    expect(first.text()).toContain('from output');
    expect(first.text()).toContain('EOR feeds the input by default.');
    const second = wrapper.find('[data-test="normalization-2"]');
    expect(second.text()).toContain('internal oscillator');
    expect(second.text()).toContain('internal signal');
  });

  it('still offers the add form when no normalizations are recorded', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, normalizations: [] });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const panel = wrapper.find('[data-test="normalizations"]');
    expect(panel.text()).toContain('No normalled connections recorded');
    expect(panel.find('table').exists()).toBe(false);
    expect(panel.find('[data-test="norm-create"]').exists()).toBe(true);
  });

  it('manually adds a normalization from a jack and from an internal signal', async () => {
    api.get.mockResolvedValue({ ...moduleResponse, normalizations: [] });
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // Targets are the module's input jacks; sources are all jacks plus the
    // internal option. The button stays disabled until the form is complete.
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('2');
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-test="norm-description"]').setValue('EOR feeds the input');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_component_id: 2,
      description: 'EOR feeds the input',
    });

    // Choosing the internal option reveals a label field and posts the label.
    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('internal');
    expect(wrapper.find('[data-test="norm-create"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="norm-source-label"]').setValue('internal oscillator');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_label: 'internal oscillator',
    });
  });

  it('deletes a normalization', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue({
      ...moduleResponse,
      normalizations: [
        {
          id: 7,
          target_component_id: 1,
          source_component_id: 2,
          source_label: null,
          kind: 'output',
          description: null,
        },
      ],
    });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-normalization-7"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/normalizations/7');
  });

  it('lists documents; only own uploads are removable', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(moduleResponse);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const docs = wrapper.find('[data-test="documents"]');
    expect(docs.text()).toContain('Make_Noise_Maths_Manual.pdf');
    expect(docs.text()).toContain('my notes');
    expect(docs.text()).toContain('shared manual');
    // Documents are retrieved by content hash, and every document exports.
    expect(wrapper.find('[data-test="doc-1"] a').attributes('href')).toBe(
      `/api/manuals/${'a'.repeat(64)}`
    );
    expect(wrapper.find('[data-test="export-doc-1"]').attributes('href')).toBe(
      `/api/manuals/${'a'.repeat(64)}/export`
    );
    expect(wrapper.find('[data-test="export-doc-2"]').attributes('href')).toBe(
      `/api/manuals/${'b'.repeat(64)}/export`
    );
    expect(wrapper.find('[data-test="delete-doc-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="delete-doc-2"]').exists()).toBe(true);

    await wrapper.find('[data-test="delete-doc-2"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/manuals/2');
  });

  it('shows module and component notes and creates a component-level note', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      notes: [
        { id: 1, title: null, body: 'module-level', component_id: null },
        { id: 2, title: 'Jack', body: 'about EOR', component_id: 2 },
      ],
    });
    api.post.mockResolvedValue({ id: 3 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const notes = wrapper.find('[data-test="notes"]');
    expect(notes.text()).toContain('module-level');
    expect(notes.text()).toContain('about EOR');
    // The component note is labeled with the component's name.
    expect(wrapper.find('[data-test="note-2-2"]').text()).toContain('EOR');

    await wrapper.find('[data-test="note-target"]').setValue('2');
    await wrapper.find('[data-test="note-body"]').setValue('watch the gate level');
    await wrapper.find('[data-test="notes"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes', {
      body: 'watch the gate level',
      component_ids: [2],
    });
  });

  it('detaches a note from the module', async () => {
    api.get.mockResolvedValue({
      ...moduleResponse,
      notes: [{ id: 1, title: null, body: 'module-level', component_id: null }],
    });
    api.post.mockResolvedValue({});
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="detach-note-1-module"]').trigger('click');
    expect(api.post).toHaveBeenCalledWith('/api/notes/1/detach', { module_id: 1 });
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

  it('shows only the selected jack, knob or toggle while arranging the panel', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [
        { id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 },
        { id: 6, component_id: 2, name: 'EOR', shape: 'jack', x: 0.6, y: 0.8 },
        { id: 7, component_id: 3, name: 'Rise', shape: 'knob', x: 0.5, y: 0.3 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.findAll('.marker')).toHaveLength(3);
    expect(wrapper.find('[data-test="arrange-component-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-2"]').exists()).toBe(true);
    // Knobs get the same button, so a single control can be placed on its own.
    expect(wrapper.find('[data-test="arrange-component-3"]').exists()).toBe(true);

    await wrapper.find('[data-test="arrange-component-3"]').trigger('click');
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('Rise');

    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="panel-arrangement-filter"]').text()).toContain('EOR');

    // The active Arranging button is itself a toggle back to the full panel.
    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    expect(wrapper.findAll('.marker')).toHaveLength(3);

    await wrapper.find('[data-test="arrange-component-2"]').trigger('click');
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    await wrapper.find('[data-test="panel-disable-arranging"]').trigger('click');
    expect(wrapper.findAll('.marker')).toHaveLength(3);
  });

  it('keeps Trim panel and Disable arranging beside the re-analyze buttons', async () => {
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

    // Both live in the action row at the top of the page, with the two
    // re-analyze buttons — not buried inside the Front panel section.
    const row = wrapper.find('[data-test="rebuild-analysis"]').element.parentElement;
    for (const test of ['panel-trim', 'panel-disable-arranging']) {
      const button = wrapper.find(`[data-test="${test}"]`);
      expect(button.exists()).toBe(true);
      expect(button.element.parentElement).toBe(row);
    }
    // Nothing is being arranged yet, so the button is visible but inert.
    expect(wrapper.find('[data-test="panel-disable-arranging"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    expect(wrapper.find('[data-test="panel-disable-arranging"]').attributes('disabled')).toBeUndefined();
  });

  it('scrolls to the panel when arranging, and back to the row from the marker', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [{ id: 5, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.4, y: 0.8 }],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    const wrapper = mount(ModuleDetailView, {
      props: { id: '1' },
      global: testGlobal(),
      attachTo: document.body,
    });
    await flushPromises();

    // Arranging brings the panel picture into view.
    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.calls[0][0]).toMatchObject({ block: 'start' });

    // A click on the marker (a press that never moves) jumps back down to
    // the component's row in the list.
    await wrapper.find('[data-test="panel-marker-1"]').trigger('pointerdown', {
      clientX: 10,
      clientY: 10,
    });
    await wrapper.find('[data-test="module-panel-svg"]').trigger('pointerup');
    await flushPromises();
    expect(scrolled).toHaveBeenCalledTimes(2);
    expect(scrolled.mock.calls[1][0]).toMatchObject({ block: 'center' });
    wrapper.unmount();
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
    const trimmed = {
      ...panel,
      crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 },
    };
    api.post.mockResolvedValue({ panel: trimmed });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="panel-trim"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/trim');
    expect(wrapper.find('[data-test="panel-status"]').text()).toContain('Trimmed');
    // The marker survives the new crop, mapped through it by the renderer.
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(true);
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

  it('offers Arrange on buttons, displays and toggles, but not on switches', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [],
    };
    api.get.mockResolvedValue({
      ...moduleResponse,
      components: [
        { id: 4, type: 'button', name: 'Cycle', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 5, type: 'display', name: 'Level LED', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 6, type: 'toggle', name: 'Range', description: null, voltage_min: null, voltage_max: null, polarity: null },
        { id: 7, type: 'switch', name: 'Mode', description: null, voltage_min: null, voltage_max: null, polarity: null },
      ],
      panel,
    });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="arrange-component-4"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-5"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-6"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="arrange-component-7"]').exists()).toBe(false);
  });

  it('creates a panel marker when arranging an analyzed jack the image mapper missed', async () => {
    const panel = {
      source: 'image',
      url: '/api/panels/abc.png',
      width: 400,
      height: 1200,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      components: [
        { id: 6, component_id: 2, name: 'EOR', shape: 'jack', x: 0.6, y: 0.8 },
      ],
    };
    const repairedPanel = {
      ...panel,
      components: [
        ...panel.components,
        { id: 8, component_id: 1, name: 'Signal In', shape: 'jack', x: 0.5, y: 0.9 },
      ],
    };
    api.get.mockResolvedValue({ ...moduleResponse, panel });
    api.post.mockResolvedValue({ panel: repairedPanel, placement_id: 8 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="arrange-component-1"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/panel/components', { component_id: 1 });
    expect(wrapper.findAll('.marker')).toHaveLength(1);
    expect(wrapper.find('[data-test="panel-marker-1"]').exists()).toBe(true);
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

  it('uploads an additional PDF as base64 with a required name', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ id: 3 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The file is chosen first: nothing is sent yet, and the name comes from
    // the file so the upload needs no name of its own.
    expect(wrapper.find('[data-test="doc-upload"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="doc-send"]').attributes('disabled')).toBeDefined();

    const file = new File(['%PDF-1.4 fake pdf'], 'extra.pdf', { type: 'application/pdf' });
    wrapper.findComponent(DocumentsSection).vm.onFileChosen({ target: { files: [file] } });
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="doc-name"]').element.value).toBe('extra');
    expect(wrapper.find('[data-test="doc-send"]').attributes('disabled')).toBeUndefined();

    // The derived name can be replaced before the upload happens; 'manual' is
    // still refused, since the found manual owns that name.
    await wrapper.find('[data-test="doc-name"]').setValue('manual');
    expect(wrapper.find('[data-test="doc-send"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="doc-name-hint"]').exists()).toBe(true);
    await wrapper.find('[data-test="doc-name"]').setValue('calibration guide');
    expect(wrapper.find('[data-test="doc-send"]').attributes('disabled')).toBeUndefined();

    // Marking the upload for analysis rides along with the request.
    await wrapper.find('[data-test="doc-scope"]').setValue(true);

    await wrapper.find('[data-test="doc-send"]').trigger('click');
    // The FileReader behind the upload resolves on a task, not a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      '/api/modules/1/manuals',
      expect.objectContaining({
        name: 'calibration guide',
        filename: 'extra.pdf',
        data_base64: expect.any(String),
        analysis_scope: true,
      })
    );
    const { data_base64 } = api.post.mock.calls[0][1];
    expect(atob(data_base64)).toContain('%PDF-1.4');
  });

  it("toggles a document's analysis scope, but never on one shared with you", async () => {
    api.get.mockResolvedValue({
      ...structuredClone(moduleResponse),
      manuals: [
        { id: 1, hash: 'a'.repeat(64), name: 'manual', original_name: 'Make_Noise_Maths_Manual.pdf', source: 'found', user_id: null, analysis_scope: false, has_text: true, text_pages: 12 },
        { id: 2, hash: 'b'.repeat(64), name: 'my notes', original_name: 'my-notes.pdf', source: 'upload', user_id: 2, analysis_scope: true, has_text: false, text_pages: null },
        { id: 3, hash: 'c'.repeat(64), name: 'from bob', original_name: 'bobs.pdf', source: 'upload', user_id: 9, shared_by: 'bob', analysis_scope: true, has_text: false, text_pages: null },
      ],
    });
    api.put.mockResolvedValue({ id: 1, analysis_scope: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const shared = wrapper.find('[data-test="scope-doc-1"]');
    expect(shared.element.checked).toBe(false);
    await shared.setValue(true);
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/manuals/1/scope', {
      analysis_scope: true,
    });
    expect(shared.element.checked).toBe(true);

    // Your own upload starts checked from the server's answer; a document
    // somebody shared with you is theirs to mark, not yours.
    expect(wrapper.find('[data-test="scope-doc-2"]').element.checked).toBe(true);
    expect(wrapper.find('[data-test="scope-doc-3"]').attributes('disabled')).toBeDefined();
  });
});


describe('ModuleDetailView component values', () => {
  const moduleResponse = {
    id: 1,
    manufacturer: 'Make Noise',
    name: 'Maths',
    manual_status: 'found',
    analysis_status: 'complete',
    summary: 'x',
    quantity: 1,
    racks: [{ id: 1, name: 'main rack', quantity: 1 }],
    manuals: [],
    components: [
      { id: 3, type: 'knob', name: 'Rise', description: null, voltage_min: null, voltage_max: null, polarity: null,
        values: [
          { id: 1, type: 'min', value: '0' },
          { id: 2, type: 'max', value: '10' },
        ] },
      { id: 4, type: 'switch', name: 'Mode', description: null, voltage_min: null, voltage_max: null, polarity: null,
        values: [{ id: 3, type: 'enum', value: 'Cycle', description: 'loops' }] },
    ],
  };

  it('summarizes values in the component tables and lists them for editing', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="group-knob"]').text()).toContain('0 … 10');
    expect(wrapper.find('[data-test="group-switch"]').text()).toContain('Cycle');
    const row = wrapper.find('[data-test="value-3"]');
    expect(row.text()).toContain('Mode');
    expect(row.text()).toContain('loops');
  });

  it('reclassifies a component as a mult jack with a group', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 4, type: 'bidirectional_jack', group_label: '1' });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="edit-component-4"]').trigger('click');
    await wrapper.find('[data-test="edit-type-4"]').setValue('bidirectional_jack');
    // The group field only appears for bidirectional jacks.
    await wrapper.find('[data-test="edit-group-4"]').setValue('1');
    await wrapper.find('[data-test="edit-save-4"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/4', {
      // The unchanged name and description ride along with the correction.
      name: 'Mode',
      description: '',
      type: 'bidirectional_jack',
      group_label: '1',
      // Jacks also carry the physical connector; '' keeps it an ordinary
      // 3.5mm patch point.
      port_kind: '',
    });
  });

  it('renames a component and edits its description', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 3, name: 'Rise Time', description: 'Attack slope' });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The row shows text until it is put into edit mode.
    expect(wrapper.find('[data-test="edit-name-3"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-component-3"]').trigger('click');
    // The existing wording is what you start from.
    expect(wrapper.find('[data-test="edit-name-3"]').element.value).toBe('Rise');
    await wrapper.find('[data-test="edit-name-3"]').setValue('Rise Time');
    await wrapper.find('[data-test="edit-description-3"]').setValue('Attack slope');
    await wrapper.find('[data-test="edit-save-3"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/3', {
      name: 'Rise Time',
      description: 'Attack slope',
      type: 'knob',
      group_label: '',
      port_kind: '',
    });
  });

  it('will not save a component with a blank name', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="edit-component-3"]').trigger('click');
    await wrapper.find('[data-test="edit-name-3"]').setValue('   ');
    expect(wrapper.find('[data-test="edit-save-3"]').attributes('disabled')).toBeDefined();
  });

  it('adds and removes a value', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ id: 9 });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="value-component"]').setValue('4');
    await wrapper.find('[data-test="value-type"]').setValue('enum');
    await wrapper.find('[data-test="value-value"]').setValue('Sustain');
    await wrapper.find('[data-test="value-description"]').setValue('holds');
    await wrapper.find('[data-test="values"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/components/4/values', {
      type: 'enum',
      value: 'Sustain',
      description: 'holds',
    });

    await wrapper.find('[data-test="delete-value-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/components/3/values/1');
  });

  it('edits the label and description of a value the analysis wrote', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.put.mockResolvedValue({ id: 3, value: 'Cycle', description: 'repeats the envelope' });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The row shows text until it is put into edit mode.
    expect(wrapper.find('[data-test="edit-value-description-3"]').exists()).toBe(false);
    await wrapper.find('[data-test="edit-value-3"]').trigger('click');
    // The existing wording is what you start from.
    expect(wrapper.find('[data-test="edit-value-description-3"]').element.value).toBe('loops');
    await wrapper
      .find('[data-test="edit-value-description-3"]')
      .setValue('repeats the envelope');
    await wrapper.find('[data-test="save-value-3"]').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/modules/1/components/4/values/3', {
      value: 'Cycle',
      description: 'repeats the envelope',
    });
    // Saving closes the editor and the reloaded row takes over.
    expect(wrapper.find('[data-test="edit-value-description-3"]').exists()).toBe(false);
  });
});

// Signal paths that are not simply "this jack to that jack": defaults that
// depend on a switch, connections that are not 3.5mm patch points, expander
// panels, bridges, and everything a patch records beyond its cables.

describe('ModuleDetailView signal-path detail', () => {
  const conditionalModule = {
    id: 1,
    manufacturer: 'Intellijel',
    name: 'Atlantix',
    manual_status: 'found',
    analysis_status: 'complete',
    summary: 'x',
    quantity: 1,
    racks: [{ id: 1, name: 'main rack', quantity: 1 }],
    manuals: [],
    notes: [],
    components: [
      { id: 1, type: 'input_jack', name: 'PWM IN', values: [] },
      { id: 2, type: 'output_jack', name: 'SINE B', values: [] },
      { id: 3, type: 'output_jack', name: 'L', port_kind: null, values: [] },
      { id: 4, type: 'output_jack', name: 'R', values: [] },
      {
        id: 5,
        type: 'switch',
        name: 'PWM SOURCE',
        values: [
          { id: 9, type: 'enum', value: 'left' },
          { id: 10, type: 'enum', value: 'right' },
        ],
      },
      { id: 6, type: 'input_jack', name: 'MIDI IN', port_kind: 'midi_din', values: [] },
    ],
    normalizations: [
      {
        id: 41,
        target_component_id: 1,
        source_component_id: 2,
        source_label: null,
        kind: 'output',
        condition_component_id: 5,
        condition_value: 'left',
        alt_group: 'pwm source',
        break_component_id: null,
        break_on: 'cable_in',
        description: null,
      },
      {
        id: 42,
        target_component_id: 4,
        source_component_id: 3,
        source_label: null,
        kind: 'output',
        condition_component_id: null,
        condition_value: null,
        alt_group: null,
        break_component_id: 3,
        break_on: 'cable_out',
        description: 'Patching only R gives a mono sum.',
      },
    ],
    routes: [
      {
        id: 51,
        input_component_id: 1,
        output_component_id: 2,
        condition_component_id: 5,
        condition_value: 'right',
        alt_group: 'pwm source',
        description: null,
      },
    ],
    switches: [],
    pairs: [{ id: 61, a_component_id: 3, b_component_id: 4, kind: 'stereo', description: null }],
    expanders: [
      { id: 71, role: 'expander', module_id: 2, manufacturer: 'Intellijel', name: 'Atlx', description: null },
    ],
    expander_components: [{ id: 80, module_id: 2, type: 'output_jack', name: 'LP', port_kind: null }],
    expander_suggestions: [
      { name: 'Performer', role: 'expander', description: null, module_id: null },
    ],
  };

  it('shows the control position a default or a path depends on, and what breaks it', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const condition = wrapper.find('[data-test="normalization-condition-41"]');
    expect(condition.text()).toContain('PWM SOURCE = left');
    expect(condition.text()).toContain('pwm source');
    // The output-to-output default names the cable that cancels it.
    expect(wrapper.find('[data-test="normalization-42"]').text()).toContain('a cable out of L');
    expect(wrapper.find('[data-test="route-condition-51"]').text()).toContain('PWM SOURCE = right');
    // A default with no condition reads as unconditional.
    expect(wrapper.find('[data-test="normalization-42"]').text()).toContain('always');
  });

  it('records a default that only exists in one switch position', async () => {
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 43 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="norm-target"]').setValue('1');
    await wrapper.find('[data-test="norm-source"]').setValue('2');
    await wrapper.find('[data-test="norm-condition"]').setValue('5');
    // The switch's recorded positions become the choices.
    const values = wrapper.findAll('[data-test="norm-condition-value"] option').map((o) => o.text());
    expect(values).toContain('right');
    await wrapper.find('[data-test="norm-condition-value"]').setValue('right');
    await wrapper.find('[data-test="norm-alt-group"]').setValue('pwm source');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 1,
      source_component_id: 2,
      condition_component_id: 5,
      condition_value: 'right',
      alt_group: 'pwm source',
    });
  });

  it('records the jack whose outgoing cable breaks a default', async () => {
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 44 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="norm-target"]').setValue('4');
    await wrapper.find('[data-test="norm-source"]').setValue('3');
    await wrapper.find('[data-test="norm-break"]').setValue('3');
    await wrapper.find('[data-test="norm-break-on"]').setValue('cable_out');
    await wrapper.find('[data-test="normalizations"] form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/modules/1/normalizations', {
      target_component_id: 4,
      source_component_id: 3,
      break_component_id: 3,
      break_on: 'cable_out',
    });
  });

  it('shows connectors that are not 3.5mm patch points', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const inputs = wrapper.find('[data-test="group-input_jack"]').text();
    expect(inputs).toContain('midi din');
    expect(inputs).toContain('3.5mm');
  });

  it('lists stereo pairs and expander panels, and offers the expander’s jacks in a path', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="pair-61"]').text()).toContain('stereo');
    expect(wrapper.find('[data-test="expander-71"]').text()).toContain('Atlx');
    expect(wrapper.find('[data-test="expander-71"]').text()).toContain('expands this module');
    // A route may end at a jack on the linked panel.
    const outputs = wrapper.findAll('[data-test="route-output"] option').map((o) => o.text());
    expect(outputs.some((t) => t.includes('LP — Intellijel Atlx'))).toBe(true);
  });

  it('adds a stereo pair and an expander link', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.post.mockResolvedValue({ id: 62 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="pair-a"]').setValue('3');
    await wrapper.find('[data-test="pair-b"]').setValue('4');
    await wrapper.find('[data-test="pairs"] form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/pairs', {
      a_component_id: 3,
      b_component_id: 4,
      kind: 'stereo',
    });

    await wrapper.find('[data-test="delete-expander-71"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/expanders/71');
  });

  it('points out a panel the manual named that is not linked yet', async () => {
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    const suggestion = wrapper.find('[data-test="expander-suggestion-0"]');
    expect(suggestion.text()).toContain('Performer');
    expect(suggestion.text()).toContain('not in any of your racks');
  });

  it('removes a stereo pair once the user confirms', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove jack pair', danger: true })
    );
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/pairs/61');
    // The module is reloaded so the pair list reflects the server.
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1')).toHaveLength(2);
  });

  it('keeps the pair when the confirm is declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(conditionalModule);
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1')).toHaveLength(1);
  });

  it('shows why a pair could not be removed', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(conditionalModule);
    api.delete.mockRejectedValue(new Error('pair is gone already'));
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-pair-61"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="pair-error"]').text()).toContain('gone already');
  });
});

describe('ModuleDetailView videos', () => {
  const moduleResponse = {
    id: 1,
    manufacturer: 'Make Noise',
    name: 'Maths',
    manual_status: 'found',
    analysis_status: 'complete',
    summary: 'x',
    quantity: 1,
    racks: [{ id: 1, name: 'main rack', quantity: 1 }],
    manuals: [],
    components: [],
    videos: [
      {
        id: 5,
        video_id: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Maths tricks',
        channel: 'Synth Channel',
        duration_seconds: 300,
        status: 'complete',
        summary: '## Slew plucks\n\nPatch the EOR out into…',
        error: null,
      },
      {
        id: 6,
        video_id: 'AAAAAAAAAAA',
        url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
        title: null,
        channel: null,
        duration_seconds: null,
        status: 'downloading',
        summary: null,
        error: null,
      },
      {
        id: 7,
        video_id: 'BBBBBBBBBBB',
        url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
        title: 'broken one',
        channel: 'Someone',
        duration_seconds: 60,
        status: 'failed',
        summary: null,
        error: 'yt-dlp failed (exit 1): video unavailable',
      },
    ],
  };

  it('lists the videos with status, rendered summary, progress and failure notes', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="video-5"]');
    expect(row.text()).toContain('Maths tricks');
    expect(row.text()).toContain('Synth Channel');
    expect(row.text()).toContain('5 min');
    expect(row.find('a').attributes('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(wrapper.find('[data-test="video-status-5"]').text()).toBe('complete');
    // The summary is markdown, rendered (and sanitized) to HTML.
    expect(wrapper.find('[data-test="video-summary-5"] h2').text()).toBe('Slew plucks');

    // A video mid-pipeline says so; its link falls back to the URL.
    const pending = wrapper.find('[data-test="video-6"]');
    expect(pending.find('a').text()).toContain('youtube.com/watch?v=AAAAAAAAAAA');
    expect(wrapper.find('[data-test="video-working-6"]').exists()).toBe(true);

    // A failed one shows the error and offers a retry.
    expect(wrapper.find('[data-test="video-error-7"]').text()).toContain('video unavailable');
    expect(wrapper.find('[data-test="retry-video-7"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="retry-video-5"]').exists()).toBe(false);
  });

  it('attaches a YouTube link and reloads', async () => {
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), videos: [] });
    api.post.mockResolvedValue({ id: 9, job_id: 4 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="video-send"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="video-url"]').setValue('https://youtu.be/dQw4w9WgXcQ');
    expect(wrapper.find('[data-test="video-send"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-test="video-send"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/videos', {
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(wrapper.find('[data-test="video-url"]').element.value).toBe('');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1').length).toBeGreaterThan(1);
  });

  it('shows the server refusal for a link that is not a video', async () => {
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), videos: [] });
    api.post.mockRejectedValue(new Error('url must be a link to a YouTube video'));
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="video-url"]').setValue('https://vimeo.com/123');
    await wrapper.find('[data-test="video-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="video-add-error"]').text()).toContain('YouTube');
  });

  it('retries a failed video by re-posting its URL', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.post.mockResolvedValue({ id: 7, job_id: 8 });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="retry-video-7"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/videos', {
      url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
    });
  });

  it('removes a video after confirming, and not without', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-video-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="delete-video-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/videos/5');
  });
});
