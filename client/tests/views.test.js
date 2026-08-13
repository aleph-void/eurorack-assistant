import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

import { api } from '../src/api.js';
import { dialog } from '../src/dialog.js';
import LoginView from '../src/views/LoginView.vue';
import ModulesView from '../src/views/ModulesView.vue';
import ModuleDetailView from '../src/views/ModuleDetailView.vue';
import RacksView from '../src/views/RacksView.vue';
import ImportView from '../src/views/ImportView.vue';
import AskView from '../src/views/AskView.vue';
import QuestionsView from '../src/views/QuestionsView.vue';
import QuestionDetailView from '../src/views/QuestionDetailView.vue';
import JobsView from '../src/views/JobsView.vue';
import UsersView from '../src/views/UsersView.vue';
import ChangePasswordView from '../src/views/ChangePasswordView.vue';
import ConfigView from '../src/views/ConfigView.vue';
import NotesView from '../src/views/NotesView.vue';
import PatchesView from '../src/views/PatchesView.vue';
import PatchDetailView from '../src/views/PatchDetailView.vue';
import { useJobsStore } from '../src/stores/jobs.js';
import { useAuthStore } from '../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('LoginView', () => {
  it('logs in and navigates to modules', async () => {
    api.post.mockResolvedValue({ id: 1, username: 'alice', is_admin: false });
    const wrapper = mount(LoginView, { global: testGlobal() });
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('pw123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/login', {
      username: 'alice',
      password: 'pw123',
    });
    expect(routerPush).toHaveBeenCalled();
  });

  it('shows a login error', async () => {
    api.post.mockRejectedValue(new Error('Invalid username or password'));
    const wrapper = mount(LoginView, { global: testGlobal() });
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('bad');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Invalid');
  });
});

describe('ModulesView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 1 },
    { id: 2, name: 'travel case', module_count: 0 },
  ];

  // ModulesView loads the rack list and the (optionally rack-scoped) modules.
  function mockLists(modules) {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : modules)
    );
  }

  it('renders the module table with status badges and rack placements', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 2,
        racks: [{ id: 1, name: 'main rack', quantity: 2 }],
        manual_status: 'found',
        analysis_status: 'complete',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/modules');
    const row = wrapper.find('[data-test="module-1"]');
    expect(row.text()).toContain('Make Noise');
    expect(row.text()).toContain('Maths');
    expect(row.text()).toContain('main rack');
    expect(row.text()).toContain('found');
    expect(row.text()).toContain('complete');
  });

  it('shows the empty state', async () => {
    mockLists([]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.text()).toContain('No modules yet');
  });

  // Each rack is its own collapsible section, so a system of several racks
  // reads as the racks it is made of.
  it('files the modules under a collapsible section per rack', async () => {
    mockLists([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 1,
        racks: [{ id: 1, name: 'main rack', quantity: 1 }],
        manual_status: 'found',
        analysis_status: 'complete',
      },
      {
        id: 2,
        manufacturer: 'ALM',
        name: 'Pam',
        quantity: 1,
        racks: [{ id: 2, name: 'travel case', quantity: 1 }],
        manual_status: 'pending',
        analysis_status: 'pending',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    const main = wrapper.find('[data-test="rack-group-1"]');
    const travel = wrapper.find('[data-test="rack-group-2"]');
    expect(main.text()).toContain('main rack');
    expect(main.find('[data-test="module-1"]').exists()).toBe(true);
    expect(main.find('[data-test="module-2"]').exists()).toBe(false);
    expect(travel.find('[data-test="module-2"]').exists()).toBe(true);
    // The first rack starts open; the rest are one click away.
    expect(main.attributes('open')).toBeDefined();
    expect(travel.attributes('open')).toBeUndefined();
  });

  it('narrows the list to the selected rack', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(2);
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/modules?rack_id=2');
  });

  it('moves a module to another rack from the rack-scoped view', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.post.mockResolvedValue({ ok: true });
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    await wrapper.find('[data-test="move-1"]').setValue(2);
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks/1/modules/1/move', { to_rack_id: 2 });
  });

  it('deletes a module after confirmation, scoped to the selected rack', async () => {
    mockLists([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, racks: [], manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="module-1"] button').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1');

    await wrapper.find('[data-test="rack-select"]').setValue(1);
    await flushPromises();
    await wrapper.find('[data-test="module-1"] button.danger').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1?rack_id=1');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('RacksView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3 },
    { id: 2, name: 'travel case', module_count: 1 },
  ];

  it('lists racks with module counts and creates a new one', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ id: 3, name: 'studio', module_count: 0 });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack-1"]').text()).toContain('main rack');
    expect(wrapper.find('[data-test="rack-1"]').text()).toContain('3');
    expect(wrapper.find('[data-test="rack-2"]').text()).toContain('travel case');

    await wrapper.find('[data-test="new-rack"]').setValue('studio');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks', { name: 'studio' });
  });

  it('renames a rack', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.put.mockResolvedValue({ id: 2, name: 'live case', module_count: 1 });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rename-2"]').trigger('click');
    await wrapper.find('[data-test="rename-input-2"]').setValue('live case');
    await wrapper.find('[data-test="rack-2"] form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/racks/2', { name: 'live case' });
  });

  it('queues a rack export and tells the user the download is automatic', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ id: 12, type: 'export_rack', status: 'pending' });
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="export-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/racks/1/export');
    expect(wrapper.find('[data-test="notice"]').text()).toContain('downloads automatically');

    api.post.mockRejectedValue(new Error('Rack not found'));
    await wrapper.find('[data-test="export-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Rack not found');
  });

  it('deletes a rack after confirmation and surfaces errors', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(RacksView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/racks/2');
    expect(wrapper.find('[data-test="rack-2"]').exists()).toBe(false);

    api.delete.mockRejectedValue(new Error('nope'));
    await wrapper.find('[data-test="delete-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('nope');
    vi.restoreAllMocks();
  });
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

    // The file input stays disabled until a valid name (not 'manual') is set.
    expect(wrapper.find('[data-test="doc-upload"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="doc-name"]').setValue('manual');
    expect(wrapper.find('[data-test="doc-upload"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="doc-name"]').setValue('calibration guide');
    expect(wrapper.find('[data-test="doc-upload"]').attributes('disabled')).toBeUndefined();

    const file = new File(['%PDF-1.4 fake pdf'], 'extra.pdf', { type: 'application/pdf' });
    await wrapper.vm.uploadDocument(file);
    expect(api.post).toHaveBeenCalledWith(
      '/api/modules/1/manuals',
      expect.objectContaining({
        name: 'calibration guide',
        filename: 'extra.pdf',
        data_base64: expect.any(String),
      })
    );
    const { data_base64 } = api.post.mock.calls[0][1];
    expect(atob(data_base64)).toContain('%PDF-1.4');
  });
});

describe('ImportView', () => {
  // ImportView loads the user's racks on mount to populate the rack selector.
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 1 },
    { id: 2, name: 'travel case', module_count: 0 },
  ];

  it('submits a text import into the default rack and shows the queued job', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 42, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="content"]').setValue('Make Noise,Maths');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'Make Noise,Maths',
      rack: 'main rack',
    });
    expect(wrapper.find('[data-test="queued"]').text()).toContain('#42');
    expect(wrapper.find('[data-test="feed"]').exists()).toBe(true);
  });

  it('submits a modulargrid import', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 1, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="mode"]').setValue('modulargrid');
    await wrapper.find('[data-test="url"]').setValue('https://modulargrid.net/e/racks/view/1');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'modulargrid',
      url: 'https://modulargrid.net/e/racks/view/1',
      rack: 'main rack',
    });
  });

  it('imports into a selected existing rack', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 2, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="rack-select"]').setValue(2);
    await wrapper.find('[data-test="content"]').setValue('ALM,Pam');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'ALM,Pam',
      rack: 'travel case',
    });
  });

  it('creates a new rack to import into', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.post.mockResolvedValue({ job_id: 3, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack"]').exists()).toBe(false);
    await wrapper.find('[data-test="rack-select"]').setValue('');
    await wrapper.find('[data-test="rack"]').setValue('modular on the go');
    await wrapper.find('[data-test="content"]').setValue('ALM,Pam');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'ALM,Pam',
      rack: 'modular on the go',
    });
  });

  it('defaults to creating a new rack when the user has none', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({ job_id: 4, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="rack"]').exists()).toBe(true);
    await wrapper.find('[data-test="rack"]').setValue('first rack');
    await wrapper.find('[data-test="content"]').setValue('Make Noise,Maths');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'Make Noise,Maths',
      rack: 'first rack',
    });
  });

  it('shows live progress lines from the jobs store', async () => {
    api.post.mockResolvedValue({ job_id: 7, status: 'pending' });
    const global = testGlobal();
    const wrapper = mount(ImportView, { global });
    await wrapper.find('[data-test="content"]').setValue('x');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const jobs = useJobsStore();
    jobs.applyEvent({
      kind: 'job',
      event: 'progress',
      job: { id: 7, type: 'import' },
      message: 'created: Make Noise Maths',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="feed"]').text()).toContain('created: Make Noise Maths');
  });

  it('surfaces API errors', async () => {
    api.post.mockRejectedValue(new Error('content is required'));
    const wrapper = mount(ImportView, { global: testGlobal() });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('content is required');
  });
});

describe('AskView', () => {
  it('submits a question and navigates to its detail page', async () => {
    api.post.mockResolvedValue({ id: 12, status: 'pending' });
    const wrapper = mount(AskView, { global: testGlobal() });
    await wrapper.find('[data-test="prompt"]').setValue('How do I patch a krell?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', { prompt: 'How do I patch a krell?' });
    expect(routerPush).toHaveBeenCalledWith({ name: 'question-detail', params: { id: 12 } });
  });

  it('disables submit with an empty prompt', () => {
    const wrapper = mount(AskView, { global: testGlobal() });
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeDefined();
  });

  it('asks about the patch named in the URL', async () => {
    currentRouteQuery = { patch: '3' };
    api.get.mockResolvedValue([
      { id: 3, name: 'Krell', rack_name: 'main rack' },
      { id: 4, name: 'Drone', rack_name: 'main rack' },
    ]);
    api.post.mockResolvedValue({ id: 12 });
    const wrapper = mount(AskView, { global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="ask-patch"]').element.value).toBe('Krell');
    await wrapper.find('[data-test="prompt"]').setValue('Why is there no sound?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'Why is there no sound?',
      patch_id: 3,
    });
  });

  it('finds a patch by typing its name', async () => {
    api.get.mockResolvedValue([
      { id: 3, name: 'Krell', rack_name: 'main rack' },
      { id: 4, name: 'Drone', rack_name: 'main rack' },
    ]);
    api.post.mockResolvedValue({ id: 12 });
    const wrapper = mount(AskView, { global: testGlobal() });
    await flushPromises();

    const box = wrapper.find('[data-test="ask-patch"]');
    await box.trigger('focus');
    await box.setValue('dro');
    const options = wrapper.findAll('[data-test^="ask-patch-option-"]');
    expect(options).toHaveLength(1);
    await box.trigger('keydown', { key: 'Enter' });

    await wrapper.find('[data-test="prompt"]').setValue('What is this?');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions', {
      prompt: 'What is this?',
      patch_id: 4,
    });
  });
});

describe('QuestionsView', () => {
  it('lists questions with status', async () => {
    api.get.mockResolvedValue([
      { id: 1, prompt: 'Q1?', status: 'answered', created_at: new Date().toISOString() },
      { id: 2, prompt: 'Q2?', status: 'pending', created_at: new Date().toISOString() },
    ]);
    const wrapper = mount(QuestionsView, { global: testGlobal() });
    await flushPromises();
    const text = wrapper.find('[data-test="question-table"]').text();
    expect(text).toContain('Q1?');
    expect(text).toContain('answered');
    expect(text).toContain('pending');
  });

  it('deletes a question after confirmation', async () => {
    api.get.mockResolvedValue([
      { id: 1, prompt: 'Q1?', status: 'answered', created_at: new Date().toISOString() },
      { id: 2, prompt: 'Q2?', status: 'pending', created_at: new Date().toISOString() },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(QuestionsView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-question-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/questions/1');
    expect(wrapper.find('[data-test="question-table"]').text()).not.toContain('Q1?');

    // Declining the confirmation leaves the question alone.
    dialog.confirm.mockResolvedValue(false);
    await wrapper.find('[data-test="delete-question-2"]').trigger('click');
    expect(api.delete).toHaveBeenCalledTimes(1);
  });
});

describe('QuestionDetailView', () => {
  it('renders the answer as sanitized markdown with scoped modules and jacks', async () => {
    api.get.mockResolvedValue({
      id: 1,
      prompt: 'How?',
      status: 'answered',
      answer: '# Patch\n\nUse **Maths**. <script>alert(1)</script>',
      modules: [{ id: 3, manufacturer: 'Make Noise', name: 'Maths' }],
      components: [
        { id: 9, name: 'EOR', type: 'output_jack', module_manufacturer: 'Make Noise', module_name: 'Maths' },
      ],
      manuals: [
        { id: 11, module_id: 3, name: 'manual', module_manufacturer: 'Make Noise', module_name: 'Maths' },
      ],
      answers: [{ id: 7, prompt: 'Earlier question?', answered_at: null }],
      notes: [{ id: 5, title: 'Krell note' }],
    });
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="modules"]').text()).toContain('Make Noise Maths');
    expect(wrapper.find('[data-test="components"]').text()).toContain('EOR');
    const attachments = wrapper.find('[data-test="attachments"]').text();
    expect(attachments).toContain('manual');
    expect(attachments).toContain('Earlier question?');
    expect(attachments).toContain('Krell note');
    const html = wrapper.find('[data-test="answer"]').html();
    expect(html).toContain('<strong>Maths</strong>');
    expect(html).not.toContain('<script>');
  });

  it('shows a scoping indicator while modules are being determined', async () => {
    api.get.mockResolvedValue({ id: 1, prompt: 'How?', status: 'scoping', modules: [], components: [] });
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="scoping"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('deletes the question after confirmation and returns to the list', async () => {
    api.get.mockResolvedValue({
      id: 1,
      prompt: 'How?',
      status: 'answered',
      answer: 'A',
      modules: [],
      components: [],
      manuals: [],
      answers: [],
      notes: [],
    });
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-question"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/questions/1');
    expect(routerPush).toHaveBeenCalledWith('/questions');
    wrapper.unmount();
  });

  it('presents the review step for a scoped question and submits the selection', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/questions/1')
        return { id: 1, prompt: 'How?', status: 'scoped', modules: [], components: [] };
      if (path === '/api/questions/1/options')
        return {
          modules: [
            { id: 3, manufacturer: 'Make Noise', name: 'Maths', in_scope: true },
            { id: 4, manufacturer: '2hp', name: 'Pluck', in_scope: false },
          ],
          components: [{ id: 9, module_id: 3, name: 'EOR', type: 'output_jack', in_scope: true }],
          manuals: [
            { id: 11, module_id: 3, name: 'manual', original_name: null, source: 'found' },
            { id: 12, module_id: 3, name: 'my notes', original_name: 'n.pdf', source: 'upload' },
            { id: 13, module_id: 4, name: 'manual', original_name: null, source: 'found' },
          ],
          answers: [
            { id: 7, prompt: 'Earlier?', answered_at: null, module_ids: [3], component_ids: [] },
          ],
          notes: [{ id: 5, title: 'Krell', body: 'x', module_ids: [], component_ids: [9] }],
          patches: [
            {
              id: 6,
              name: 'Krell patch',
              rack_name: 'main rack',
              attached: false,
              module_ids: [4],
            },
          ],
        };
      throw new Error(`unexpected ${path}`);
    });
    api.post.mockResolvedValue({ id: 1, prompt: 'How?', status: 'pending', modules: [], components: [] });

    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="review"]').exists()).toBe(true);
    // The LLM-scoped module and component start checked; the other module not.
    const moduleBoxes = wrapper.findAll('[data-test="module-option"]');
    expect(moduleBoxes).toHaveLength(2);
    expect(moduleBoxes[0].element.checked).toBe(true);
    expect(moduleBoxes[1].element.checked).toBe(false);
    const componentBoxes = wrapper.findAll('[data-test="component-option"]');
    expect(componentBoxes).toHaveLength(1);
    expect(componentBoxes[0].element.checked).toBe(true);
    // Only the selected module's documents show; its primary manual starts
    // checked, the upload does not. The unselected module's manual is hidden.
    const manualBoxes = wrapper.findAll('[data-test="manual-option"]');
    expect(manualBoxes).toHaveLength(2);
    expect(manualBoxes[0].element.checked).toBe(true);
    expect(manualBoxes[1].element.checked).toBe(false);
    // The note is offered because it is linked to the selected component.
    expect(wrapper.findAll('[data-test="note-option"]')).toHaveLength(1);

    await wrapper.find('[data-test="answer-option"]').setValue(true);
    await wrapper.find('[data-test="note-option"]').setValue(true);
    await wrapper.find('[data-test="request-answer"]').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/questions/1/answer', {
      module_ids: [3],
      component_ids: [9],
      manual_ids: [11],
      answer_ids: [7],
      note_ids: [5],
      capture_ids: [],
      patch_ids: [],
    });
    expect(wrapper.find('[data-test="answer-pending"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('attaches a patch in review and pulls the modules it uses into scope', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/questions/1')
        return { id: 1, prompt: 'Why no sound?', status: 'scoped', modules: [], components: [] };
      if (path === '/api/questions/1/options')
        return {
          modules: [
            { id: 3, manufacturer: 'Make Noise', name: 'Maths', in_scope: true },
            { id: 4, manufacturer: '2hp', name: 'Pluck', in_scope: false },
          ],
          components: [],
          manuals: [{ id: 11, module_id: 3, name: 'manual', original_name: null, source: 'found' }],
          answers: [],
          notes: [],
          patches: [
            { id: 6, name: 'Krell patch', rack_name: 'main rack', attached: false, module_ids: [4] },
          ],
        };
      throw new Error(`unexpected ${path}`);
    });
    api.post.mockResolvedValue({ id: 1, status: 'pending', modules: [], components: [] });

    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const patchBox = wrapper.find('[data-test="patch-option"]');
    expect(wrapper.find('[data-test="review"]').text()).toContain('Krell patch');
    expect(patchBox.element.checked).toBe(false);
    await patchBox.setValue(true);

    // The patch's module joins the scope, so its manual comes along.
    const moduleBoxes = wrapper.findAll('[data-test="module-option"]');
    expect(moduleBoxes[1].element.checked).toBe(true);

    await wrapper.find('[data-test="request-answer"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/questions/1/answer', {
      module_ids: [3, 4],
      component_ids: [],
      manual_ids: [11],
      answer_ids: [],
      note_ids: [],
      capture_ids: [],
      patch_ids: [6],
    });
    wrapper.unmount();
  });

  it('deselecting the primary manual is allowed and unchecking a module hides its attachments', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/questions/1')
        return { id: 1, prompt: 'How?', status: 'scoped', modules: [], components: [] };
      if (path === '/api/questions/1/options')
        return {
          modules: [
            { id: 3, manufacturer: 'Make Noise', name: 'Maths', in_scope: true },
            { id: 4, manufacturer: '2hp', name: 'Pluck', in_scope: true },
          ],
          components: [],
          manuals: [
            { id: 11, module_id: 3, name: 'manual', original_name: null, source: 'found' },
            { id: 13, module_id: 4, name: 'manual', original_name: null, source: 'found' },
          ],
          answers: [],
          notes: [],
        };
      throw new Error(`unexpected ${path}`);
    });
    api.post.mockResolvedValue({ id: 1, prompt: 'How?', status: 'pending', modules: [], components: [] });

    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // Drop the second module — its manual disappears from the list — and
    // untick the first module's primary manual: no attachments remain, so
    // the submit button disables.
    const moduleBoxes = wrapper.findAll('[data-test="module-option"]');
    await moduleBoxes[1].setValue(false);
    expect(wrapper.findAll('[data-test="manual-option"]')).toHaveLength(1);
    await wrapper.find('[data-test="manual-option"]').setValue(false);
    expect(
      wrapper.find('[data-test="request-answer"]').attributes('disabled')
    ).toBeDefined();
    wrapper.unmount();
  });

  it('shows a pending indicator while the answer is being generated', async () => {
    api.get.mockResolvedValue({ id: 1, prompt: 'How?', status: 'answering', modules: [], components: [] });
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="answer-pending"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows the failure reason', async () => {
    api.get.mockResolvedValue({
      id: 1,
      prompt: 'How?',
      status: 'failed',
      error: 'No modules were determined to be in scope for this question.',
      modules: [],
      components: [],
    });
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="answer-error"]').text()).toContain('in scope');
  });
});

describe('NotesView', () => {
  const notesResponse = [
    {
      id: 1,
      title: 'Krell',
      body: 'EOR into Signal In.',
      modules: [{ id: 3, manufacturer: 'Make Noise', name: 'Maths' }],
      components: [
        { id: 9, name: 'EOR', type: 'output_jack', module_manufacturer: 'Make Noise', module_name: 'Maths' },
      ],
    },
  ];
  const modulesResponse = [
    { id: 3, manufacturer: 'Make Noise', name: 'Maths' },
    { id: 4, manufacturer: 'Mutable Instruments', name: 'Beads' },
  ];

  function mockGets() {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/notes') return JSON.parse(JSON.stringify(notesResponse));
      if (path === '/api/modules') return modulesResponse;
      if (path === '/api/modules/4') return { id: 4, components: [{ id: 20, name: 'Out L', type: 'output_jack' }] };
      throw new Error(`unexpected ${path}`);
    });
  }

  it('lists notes with their module and component attachments', async () => {
    mockGets();
    const wrapper = mount(NotesView, { global: testGlobal() });
    await flushPromises();
    const note = wrapper.find('[data-test="note-1"]');
    expect(note.text()).toContain('Krell');
    expect(note.text()).toContain('Make Noise Maths');
    expect(note.text()).toContain('EOR');
  });

  it('creates a standalone note', async () => {
    mockGets();
    api.post.mockResolvedValue({ id: 2 });
    const wrapper = mount(NotesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="note-body"]').setValue('New idea');
    await wrapper.find('[data-test="note-title"]').setValue('Idea');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes', { title: 'Idea', body: 'New idea' });
  });

  it('attaches an existing note to another module or component', async () => {
    mockGets();
    api.post.mockResolvedValue({});
    const wrapper = mount(NotesView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="attach-module-1"]').setValue('4');
    await flushPromises();
    // Component list for the chosen module was loaded.
    expect(api.get).toHaveBeenCalledWith('/api/modules/4');

    // Attach to a specific component of that module.
    await wrapper.find('[data-test="attach-component-1"]').setValue('20');
    await wrapper.find('[data-test="attach-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/notes/1/attach', { component_ids: [20] });
  });

  it('detaches and deletes notes', async () => {
    mockGets();
    api.post.mockResolvedValue({});
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(NotesView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="note-1"] .badge.found a').trigger('click');
    expect(api.post).toHaveBeenCalledWith('/api/notes/1/detach', { module_id: 3 });

    await wrapper.find('[data-test="note-delete-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/notes/1');
    vi.restoreAllMocks();
  });
});

describe('JobsView', () => {
  it('lists jobs and retries failed ones', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        type: 'find_manual',
        status: 'failed',
        attempts: 3,
        error: 'No manual PDF found',
        module_manufacturer: 'Make Noise',
        module_name: 'Maths',
      },
    ]);
    api.post.mockResolvedValue({ id: 1, status: 'pending', error: null });
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="job-table"]').text()).toContain('Make Noise Maths');
    await wrapper.find('[data-test="retry-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/1/retry');
    // A lone failure does not warrant the bulk button.
    expect(wrapper.find('[data-test="retry-all"]').exists()).toBe(false);
  });

  it('offers Retry All once more than one job has failed', async () => {
    api.get.mockResolvedValue([
      { id: 1, type: 'find_manual', status: 'failed', attempts: 3, error: 'No manual PDF found' },
      { id: 2, type: 'export_rack', status: 'complete', attempts: 1, rack_name: 'main rack' },
      { id: 3, type: 'ask_question', status: 'failed', attempts: 2, error: 'timeout' },
    ]);
    api.post.mockImplementation(async (url) => ({
      id: Number(url.split('/')[3]),
      status: 'pending',
      error: null,
    }));
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="retry-all"]').trigger('click');
    await flushPromises();
    expect(api.post.mock.calls.map((c) => c[0])).toEqual([
      '/api/jobs/1/retry',
      '/api/jobs/3/retry',
    ]);
    // Nothing failed any more, so the button goes away.
    expect(wrapper.find('[data-test="retry-all"]').exists()).toBe(false);
  });

  it('flags a stalled job and offers to retry it', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        type: 'analyze_manual',
        status: 'running',
        stalled: true,
        attempts: 1,
        module_manufacturer: 'Tiptop Audio',
        module_name: 'MISO',
      },
      { id: 2, type: 'analyze_manual', status: 'running', stalled: false, attempts: 1 },
    ]);
    api.post.mockResolvedValue({ id: 1, status: 'pending', stalled: false, error: null });
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="stalled-1"]').exists()).toBe(true);
    // A job that is genuinely still running is neither flagged nor retryable.
    expect(wrapper.find('[data-test="stalled-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="retry-2"]').exists()).toBe(false);
    await wrapper.find('[data-test="retry-1"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/jobs/1/retry');
    expect(wrapper.find('[data-test="stalled-1"]').exists()).toBe(false);
  });

  it('labels rack exports and links the not-yet-taken download', async () => {
    api.get.mockResolvedValue([
      {
        id: 2,
        type: 'export_rack',
        status: 'complete',
        attempts: 1,
        rack_name: 'main rack',
        download: '/api/exports/2',
      },
      { id: 3, type: 'export_rack', status: 'complete', attempts: 1, rack_name: 'travel case', download: null },
    ]);
    const wrapper = mount(JobsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="job-table"]').text()).toContain('main rack');
    const link = wrapper.find('[data-test="download-2"]');
    expect(link.attributes('href')).toBe('/api/exports/2');
    // Already-downloaded exports have no link (the zip is gone).
    expect(wrapper.find('[data-test="download-3"]').exists()).toBe(false);
  });
});

describe('UsersView', () => {
  it('creates a user and reveals the generated password once', async () => {
    api.get.mockResolvedValue([{ id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() }]);
    api.post.mockResolvedValue({
      id: 2,
      username: 'newbie',
      is_admin: false,
      generated_password: 'abc123xyz',
    });
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="username"]').setValue('newbie');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users', { username: 'newbie' });
    expect(wrapper.find('[data-test="generated-password"]').text()).toBe('abc123xyz');
  });

  it('resets a user password and reveals the generated password once', async () => {
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    api.post.mockResolvedValue({ ok: true, username: 'alice', generated_password: 'freshpw123' });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="reset-2"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users/2/password');
    expect(wrapper.find('[data-test="reset-password-value"]').text()).toBe('freshpw123');
    vi.restoreAllMocks();
  });

  it('lists users with roles', async () => {
    api.get.mockResolvedValue([
      { id: 1, username: 'admin', is_admin: true, created_at: new Date().toISOString() },
      { id: 2, username: 'alice', is_admin: false, created_at: new Date().toISOString() },
    ]);
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    const text = wrapper.find('[data-test="user-table"]').text();
    expect(text).toContain('admin');
    expect(text).toContain('alice');
  });
});

describe('ChangePasswordView', () => {
  it('changes the password and navigates to modules', async () => {
    api.post.mockResolvedValue({ id: 1, username: 'alice', is_admin: false, must_change_password: false });
    const wrapper = mount(ChangePasswordView, { global: testGlobal() });
    await wrapper.find('[data-test="current-password"]').setValue('old-password');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('new-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/auth/password', {
      current_password: 'old-password',
      new_password: 'new-password',
    });
    expect(routerPush).toHaveBeenCalledWith({ name: 'modules' });
  });

  it('rejects mismatched confirmation without calling the API', async () => {
    const wrapper = mount(ChangePasswordView, { global: testGlobal() });
    await wrapper.find('[data-test="current-password"]').setValue('old-password');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('different');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="error"]').text()).toContain('do not match');
  });

  it('shows the forced-change notice and API errors', async () => {
    api.post.mockRejectedValue(new Error('Current password is incorrect'));
    const global = testGlobal();
    const wrapper = mount(ChangePasswordView, { global });
    const auth = useAuthStore();
    auth.user = { id: 1, username: 'admin', is_admin: true, must_change_password: true };
    await flushPromises();
    expect(wrapper.find('[data-test="forced"]').exists()).toBe(true);

    await wrapper.find('[data-test="current-password"]').setValue('wrong');
    await wrapper.find('[data-test="new-password"]').setValue('new-password');
    await wrapper.find('[data-test="confirm-password"]').setValue('new-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('incorrect');
  });
});

describe('ConfigView', () => {
  const configResponse = {
    llm_provider: 'claude',
    llm_model: '',
    import_workers: '4',
    llm_model_find_manual: '',
    llm_model_analyze_manual: 'claude-haiku-4-5',
    llm_model_scope_question: '',
    llm_model_answer_question: '',
    providers: ['claude', 'codex'],
    known_models: { claude: ['claude-fable-5'], codex: ['gpt-5.1-codex'] },
    default_models: { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' },
    llm_job_types: ['find_manual', 'analyze_manual', 'scope_question', 'answer_question'],
  };

  it('loads current config and saves changes', async () => {
    api.get.mockResolvedValue(configResponse);
    api.put.mockResolvedValue({ llm_provider: 'codex', llm_model: 'gpt-5.1-codex' });
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="provider"]').element.value).toBe('claude');
    expect(wrapper.find('[data-test="import-workers"]').element.value).toBe('4');
    // Per-job-type model fields are populated from the config response.
    expect(wrapper.find('[data-test="model-analyze_manual"]').element.value).toBe('claude-haiku-4-5');
    expect(wrapper.find('[data-test="model-find_manual"]').element.value).toBe('');

    await wrapper.find('[data-test="provider"]').setValue('codex');
    await wrapper.find('[data-test="model"]').setValue('gpt-5.1-codex');
    await wrapper.find('[data-test="model-find_manual"]').setValue('gpt-5.1-codex-mini');
    await wrapper.find('[data-test="import-workers"]').setValue('6');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1-codex',
      import_workers: 6,
      llm_model_find_manual: 'gpt-5.1-codex-mini',
      llm_model_analyze_manual: 'claude-haiku-4-5',
      llm_model_scope_question: '',
      llm_model_answer_question: '',
    });
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(true);
  });

  it('shows save errors', async () => {
    api.get.mockResolvedValue(configResponse);
    api.put.mockRejectedValue(new Error('Invalid llm_provider: nope'));
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Invalid llm_provider');
  });
});

describe('PatchesView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3 },
    { id: 2, name: 'empty case', module_count: 0 },
  ];

  function mockLists(patches) {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/racks' ? racksResponse : patches)
    );
  }

  it('lists patches with their rack and counts', async () => {
    mockLists([
      {
        id: 5,
        name: 'Krell',
        description: 'self-generating',
        rack_name: 'main rack',
        module_count: 3,
        cable_count: 2,
        created_at: '2026-08-12T10:00:00Z',
      },
    ]);
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="patch-5"]');
    expect(row.text()).toContain('Krell');
    expect(row.text()).toContain('self-generating');
    expect(row.text()).toContain('main rack');
  });

  it('duplicates a patch from the list', async () => {
    mockLists([
      {
        id: 5,
        name: 'Krell',
        rack_name: 'main rack',
        module_count: 3,
        cable_count: 2,
        created_at: '2026-08-12T10:00:00Z',
      },
    ]);
    api.post.mockResolvedValue({ id: 6, name: 'Krell (copy)' });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="duplicate-5"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/5/clone', {});
    // The list is reloaded so the copy shows up.
    expect(api.get).toHaveBeenCalledWith('/api/patches');
  });

  it('creates a patch from the selected rack', async () => {
    mockLists([]);
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
    // The first rack that actually has modules is preselected.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('1');
    await wrapper.find('[data-test="new-name"]').setValue('Krell');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      rack_id: 1,
      name: 'Krell',
      description: undefined,
    });
  });

  it('deletes a patch after confirmation', async () => {
    mockLists([
      { id: 5, name: 'Krell', rack_name: 'main rack', module_count: 3, cable_count: 0, created_at: '2026-08-12T10:00:00Z' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/patches/5');
    expect(wrapper.find('[data-test="patch-5"]').exists()).toBe(false);
  });
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
      type: 'bidirectional_jack',
      group_label: '1',
      // Jacks also carry the physical connector; '' keeps it an ordinary
      // 3.5mm patch point.
      port_kind: '',
    });
  });

  it('adds and removes a value', async () => {
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
});
