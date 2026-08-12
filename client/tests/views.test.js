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
  it('renders the module table with status badges', async () => {
    api.get.mockResolvedValue([
      {
        id: 1,
        manufacturer: 'Make Noise',
        name: 'Maths',
        quantity: 2,
        manual_status: 'found',
        analysis_status: 'complete',
      },
    ]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="module-1"]');
    expect(row.text()).toContain('Make Noise');
    expect(row.text()).toContain('Maths');
    expect(row.text()).toContain('found');
    expect(row.text()).toContain('complete');
  });

  it('shows the empty state', async () => {
    api.get.mockResolvedValue([]);
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.text()).toContain('No modules yet');
  });

  it('deletes a module after confirmation', async () => {
    api.get.mockResolvedValue([
      { id: 1, manufacturer: 'ALM', name: 'Pam', quantity: 1, manual_status: 'pending', analysis_status: 'pending' },
    ]);
    api.delete.mockResolvedValue({ ok: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const wrapper = mount(ModulesView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="module-1"] button').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1');
    expect(wrapper.find('[data-test="module-1"]').exists()).toBe(false);
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
    // Documents are retrieved by content hash.
    expect(wrapper.find('[data-test="doc-1"] a').attributes('href')).toBe(
      `/api/manuals/${'a'.repeat(64)}`
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
  it('submits a text import and shows the queued job', async () => {
    api.post.mockResolvedValue({ job_id: 42, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await wrapper.find('[data-test="content"]').setValue('Make Noise,Maths');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'text',
      content: 'Make Noise,Maths',
    });
    expect(wrapper.find('[data-test="queued"]').text()).toContain('#42');
    expect(wrapper.find('[data-test="feed"]').exists()).toBe(true);
  });

  it('submits a modulargrid import', async () => {
    api.post.mockResolvedValue({ job_id: 1, status: 'pending' });
    const wrapper = mount(ImportView, { global: testGlobal() });
    await wrapper.find('[data-test="mode"]').setValue('modulargrid');
    await wrapper.find('[data-test="url"]').setValue('https://modulargrid.net/e/racks/view/1');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/imports', {
      type: 'modulargrid',
      url: 'https://modulargrid.net/e/racks/view/1',
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
    });
    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="modules"]').text()).toContain('Make Noise Maths');
    expect(wrapper.find('[data-test="components"]').text()).toContain('EOR');
    const html = wrapper.find('[data-test="answer"]').html();
    expect(html).toContain('<strong>Maths</strong>');
    expect(html).not.toContain('<script>');
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

    await wrapper.find('[data-test="provider"]').setValue('codex');
    await wrapper.find('[data-test="model"]').setValue('gpt-5.1-codex');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config', {
      llm_provider: 'codex',
      llm_model: 'gpt-5.1-codex',
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
