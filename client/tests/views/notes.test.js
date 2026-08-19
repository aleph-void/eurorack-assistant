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
import NotesView from '../../src/views/NotesView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
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
