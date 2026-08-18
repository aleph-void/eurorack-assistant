// The sharing UI: the button that says who can see one record, the page that
// lists both directions, and the read-only pages a recipient lands on.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerReplace = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
    useRoute: () => ({ query: {}, fullPath: '/shared' }),
  };
});

import { api } from '../src/api.js';
import { dialog } from '../src/dialog.js';
import ShareButton from '../src/components/ShareButton.vue';
import SharedView from '../src/views/SharedView.vue';
import SharedItemView from '../src/views/SharedItemView.vue';

const USERS = [
  { id: 2, username: 'alice' },
  { id: 3, username: 'bob' },
];

// Nothing shared yet, unless a test says otherwise.
const shareState = (extra = {}) => ({
  type: 'note',
  id: 7,
  label: 'Krell',
  everyone: false,
  users: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ShareButton', () => {
  const mountButton = () =>
    mount(ShareButton, {
      props: { type: 'note', id: 7, label: 'Krell' },
      global: testGlobal(),
    });

  // A page of thirty notes should not open with thirty requests, so the
  // button asks nothing until it is pressed.
  it('fetches nothing until it is opened', async () => {
    mountButton();
    await flushPromises();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('names the people who can see it, and saves a new list', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/shares/users' ? USERS : shareState())
    );
    api.put.mockResolvedValue(shareState({ users: [USERS[1]] }));

    const wrapper = mountButton();
    await wrapper.find('[data-test="share-note-7"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="share-dialog"]').exists()).toBe(true);

    await wrapper.find('[data-test="share-user-3"]').setValue(true);
    await wrapper.find('[data-test="share-save"]').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/shares/note/7', { everyone: false, user_ids: [3] });
    // The dialog closes and the button says where things stand.
    expect(wrapper.find('[data-test="share-dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="share-note-7"]').text()).toBe('Shared with bob');
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('shares with everyone', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/shares/users' ? USERS : shareState())
    );
    api.put.mockResolvedValue(shareState({ everyone: true }));

    const wrapper = mountButton();
    await wrapper.find('[data-test="share-note-7"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="share-everyone"]').setValue(true);
    await wrapper.find('[data-test="share-save"]').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/shares/note/7', { everyone: true, user_ids: [] });
    expect(wrapper.find('[data-test="share-note-7"]').text()).toBe('Shared with everyone');
  });

  it('offers to stop sharing only once something is shared', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/shares/users' ? USERS : shareState({ users: [USERS[0], USERS[1]] })
      )
    );
    api.delete.mockResolvedValue(shareState());
    // Taking access away is destructive, so it goes through the modal first.
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);

    const wrapper = mountButton();
    expect(wrapper.find('[data-test="share-note-7"]').text()).toBe('Share');
    await wrapper.find('[data-test="share-note-7"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="share-note-7"]').text()).toBe('Shared with 2 people');

    await wrapper.find('[data-test="share-stop"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith('/api/shares/note/7');
    expect(wrapper.find('[data-test="share-note-7"]').text()).toBe('Share');

    // Declining leaves the share alone.
    confirm.mockResolvedValue(false);
    api.delete.mockClear();
    await wrapper.find('[data-test="share-note-7"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="share-stop"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps the dialog open and says why when saving fails', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path === '/api/shares/users' ? USERS : shareState())
    );
    api.put.mockRejectedValue(new Error('unknown user id 9999'));

    const wrapper = mountButton();
    await wrapper.find('[data-test="share-note-7"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="share-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="share-error"]').text()).toContain('unknown user');
    expect(wrapper.find('[data-test="share-dialog"]').exists()).toBe(true);
  });
});

describe('SharedView', () => {
  const incoming = {
    patches: [{ type: 'patch', id: 4, label: 'Krell', owner_username: 'alice', rack_name: 'main' }],
    racks: [],
    notes: [{ type: 'note', id: 7, label: 'Wavefolder', owner_username: 'bob' }],
    questions: [],
    documents: [
      { type: 'document', id: 9, label: 'patch notes', owner_username: 'alice', hash: 'abc123' },
    ],
  };
  const outgoing = {
    patches: [],
    racks: [{ type: 'rack', id: 1, label: 'main rack', everyone: true, users: [] }],
    notes: [{ type: 'note', id: 2, label: 'Krell', everyone: false, users: [{ id: 3, username: 'bob' }] }],
    questions: [],
    documents: [],
  };

  const mountShared = (data = {}) => {
    api.get.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/shares/incoming'
          ? { ...incoming, ...(data.incoming ?? {}) }
          : { ...outgoing, ...(data.outgoing ?? {}) }
      )
    );
    return mount(SharedView, { global: testGlobal() });
  };

  it('lists what other people shared with you, and who from', async () => {
    const wrapper = mountShared();
    await flushPromises();
    const text = wrapper.find('[data-test="incoming-patches"]').text();
    expect(text).toContain('Krell');
    expect(text).toContain('from alice');
    expect(wrapper.find('[data-test="incoming-notes"]').text()).toContain('from bob');
    // A document is read at its content hash, not at a record id.
    expect(wrapper.find('[data-test="incoming-document-9"]').attributes('to')).toBe(
      '/manuals/abc123'
    );
    expect(wrapper.find('[data-test="incoming-documents"]').text()).toContain('patch notes');
    // ...and everything else at the read-only page for its kind.
    expect(wrapper.find('[data-test="incoming-patch-4"]').attributes('to')).toBe('/shared/patch/4');
  });

  it('lists what you share, and with whom', async () => {
    const wrapper = mountShared();
    await flushPromises();
    expect(wrapper.find('[data-test="outgoing-racks"]').text()).toContain('with everyone');
    expect(wrapper.find('[data-test="outgoing-notes"]').text()).toContain('with bob');
  });

  it('says so when there is nothing either way', async () => {
    const empty = { patches: [], racks: [], notes: [], questions: [], documents: [] };
    const wrapper = mountShared({ incoming: empty, outgoing: empty });
    await flushPromises();
    expect(wrapper.find('[data-test="no-incoming"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="no-outgoing"]').exists()).toBe(true);
  });
});

describe('SharedItemView', () => {
  const mountItem = (type, id, response) => {
    api.get.mockResolvedValue(response);
    return mount(SharedItemView, { props: { type, id: String(id) }, global: testGlobal() });
  };

  it('reads a shared note and credits its owner', async () => {
    const wrapper = mountItem('note', 7, {
      id: 7,
      title: 'Wavefolder',
      body: 'Hot signals only.',
      modules: [{ id: 1, manufacturer: 'Make Noise', name: 'Maths' }],
      components: [],
      shared: true,
      owner_username: 'alice',
    });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/notes/7');
    expect(wrapper.find('[data-test="shared-note"]').text()).toContain('Hot signals only.');
    expect(wrapper.find('[data-test="shared-by"]').text()).toContain('alice');
  });

  it('reads a shared question with its answer as markdown', async () => {
    const wrapper = mountItem('question', 3, {
      id: 3,
      prompt: 'How do I make it cycle?',
      answer: 'Patch **EOR** into Signal In.',
      status: 'answered',
      modules: [],
      shared: true,
      owner_username: 'alice',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="shared-answer"]').html()).toContain('<strong>EOR</strong>');
  });

  it('reads a shared rack as the list of what is in it', async () => {
    const wrapper = mountItem('rack', 1, {
      id: 1,
      name: 'main rack',
      module_count: 1,
      modules: [{ id: 5, manufacturer: 'ALM', name: 'Pam', hp: 8, quantity: 2, summary: 'Clocks.' }],
      shared: true,
      owner_username: 'bob',
    });
    await flushPromises();
    const row = wrapper.find('[data-test="shared-module-5"]');
    expect(row.text()).toContain('ALM Pam');
    expect(row.text()).toContain('Clocks.');
  });

  it('reads a shared patch as a diagram and a cable list', async () => {
    const wrapper = mountItem('patch', 4, {
      id: 4,
      name: 'Krell',
      rack_name: 'main rack',
      modules: [],
      cables: [
        { id: 21, from_component_name: 'EOR', to_component_name: 'Signal In', note: 'slowly' },
      ],
      settings: [{ id: 1, component_name: 'RISE', value: '2 o’clock' }],
      shared: true,
      owner_username: 'alice',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="shared-cables"]').text()).toContain('EOR → Signal In');
    expect(wrapper.find('[data-test="shared-settings"]').text()).toContain('RISE');
  });

  // A share can be withdrawn between the link being sent and being followed.
  it('explains a share that is no longer yours to read', async () => {
    const denied = Object.assign(new Error('Note not found'), { status: 404 });
    api.get.mockRejectedValue(denied);
    const wrapper = mount(SharedItemView, {
      props: { type: 'note', id: '7' },
      global: testGlobal(),
    });
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('not shared with you');
  });
});
