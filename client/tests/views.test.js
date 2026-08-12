import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
    useRoute: () => ({ query: {} }),
  };
});

import { api } from '../src/api.js';
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
import { useJobsStore } from '../src/stores/jobs.js';
import { useAuthStore } from '../src/stores/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.stubGlobal('confirm', vi.fn(() => true));
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
    vi.unstubAllGlobals();
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

  it('deletes a rack after confirmation and surfaces errors', async () => {
    api.get.mockResolvedValue(racksResponse);
    api.delete.mockResolvedValue({ ok: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
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
    vi.unstubAllGlobals();
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
      { id: 1, hash: 'a'.repeat(64), name: 'manual', original_name: 'Make_Noise_Maths_Manual.pdf', source: 'found', user_id: null },
      { id: 2, hash: 'b'.repeat(64), name: 'my notes', original_name: 'my-notes.pdf', source: 'upload', user_id: 2 },
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    const wrapper = mount(QuestionsView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-question-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/questions/1');
    expect(wrapper.find('[data-test="question-table"]').text()).not.toContain('Q1?');

    // Declining the confirmation leaves the question alone.
    vi.stubGlobal('confirm', vi.fn(() => false));
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
    vi.stubGlobal('confirm', vi.fn(() => true));
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
    });
    expect(wrapper.find('[data-test="answer-pending"]').exists()).toBe(true);
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    const wrapper = mount(NotesView, { global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="note-1"] .badge.found a').trigger('click');
    expect(api.post).toHaveBeenCalledWith('/api/notes/1/detach', { module_id: 3 });

    await wrapper.find('[data-test="note-delete-1"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/notes/1');
    vi.unstubAllGlobals();
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    const wrapper = mount(UsersView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="reset-2"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/users/2/password');
    expect(wrapper.find('[data-test="reset-password-value"]').text()).toBe('freshpw123');
    vi.unstubAllGlobals();
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
    providers: ['claude', 'codex'],
    known_models: { claude: ['claude-fable-5'], codex: ['gpt-5.1-codex'] },
    default_models: { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' },
  };

  it('loads current config and saves changes', async () => {
    api.get.mockResolvedValue(configResponse);
    api.put.mockResolvedValue({ llm_provider: 'codex', llm_model: 'gpt-5.1-codex' });
    const wrapper = mount(ConfigView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="provider"]').element.value).toBe('claude');
    expect(wrapper.find('[data-test="import-workers"]').element.value).toBe('4');

    await wrapper.find('[data-test="provider"]').setValue('codex');
    await wrapper.find('[data-test="model"]').setValue('gpt-5.1-codex');
    await wrapper.find('[data-test="import-workers"]').setValue('6');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1-codex',
      import_workers: 6,
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
