// Patches as files, from the browser's side: the export link, and reading a
// file back in.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, fullPath: '/patches' }),
  };
});

import { api } from '../src/api.js';
import PatchesView from '../src/views/PatchesView.vue';

const racks = [
  { id: 1, name: 'main rack', module_count: 3 },
  { id: 2, name: 'empty case', module_count: 0 },
];
const patches = [
  { id: 5, name: 'Krell', rack_name: 'main rack', module_count: 3, cable_count: 2, created_at: '2026-08-12T10:00:00Z' },
];

const DOCUMENT = {
  format: 'eurorack-assistant.patch',
  version: 1,
  patch: {
    name: 'Krell',
    modules: [{ ref: 1, manufacturer: 'Make Noise', module_name: 'Maths' }],
    cables: [],
  },
};

const mountView = () => {
  // The patch list arrives as one page of the library; racks and systems are
  // still plain lists.
  api.get.mockImplementation((path) => {
    if (path === '/api/racks') return Promise.resolve(racks);
    if (path === '/api/systems') return Promise.resolve([]);
    return Promise.resolve({
      total: patches.length,
      limit: 100,
      has_more: false,
      next_before: null,
      patches,
    });
  });
  return mount(PatchesView, { global: testGlobal() });
};

// Hand the file input a file and let the view read it, the way a real pick
// does. Two things jsdom does not do for us: input.files is read-only, and its
// File has no text() — the Blob method every browser this app runs in has, and
// the one ImportView already reads uploads with.
async function pick(wrapper, contents, filename = 'krell.patch.json') {
  const input = wrapper.find('[data-test="import-patch"]');
  const file = new File([contents], filename, { type: 'application/json' });
  file.text = () => Promise.resolve(contents);
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('exporting a patch', () => {
  it('offers each patch as a file at its export endpoint', async () => {
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.find('[data-test="export-5"]').attributes('href')).toBe(
      '/api/patches/5/export'
    );
  });
});

describe('importing a patch', () => {
  it('sends the parsed file, under the chosen rack, and says what came in', async () => {
    api.post.mockResolvedValue({
      id: 9,
      name: 'Krell',
      module_count: 3,
      cable_count: 2,
      unresolved_modules: [],
    });
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="import-rack"]').setValue('1');
    await pick(wrapper, JSON.stringify(DOCUMENT));

    // The rack options carry ids, so what goes up is the id itself.
    expect(api.post).toHaveBeenCalledWith('/api/patches/import', {
      document: DOCUMENT,
      rack_id: 1,
    });
    const notice = wrapper.find('[data-test="import-notice"]').text();
    expect(notice).toContain("Imported 'Krell'");
    expect(notice).toContain('3 module(s)');
    // The list is re-read so the new patch is on it.
    expect(api.get).toHaveBeenCalledWith('/api/patches?limit=100');
  });

  it('files it under no rack when none is chosen', async () => {
    api.post.mockResolvedValue({ id: 9, name: 'Krell', module_count: 1, cable_count: 0 });
    const wrapper = mountView();
    await flushPromises();
    await pick(wrapper, JSON.stringify(DOCUMENT));
    expect(api.post).toHaveBeenCalledWith('/api/patches/import', {
      document: DOCUMENT,
      rack_id: undefined,
    });
  });

  // The half of an import that matters: which modules did NOT arrive whole.
  it('names the modules that came in by name only', async () => {
    api.post.mockResolvedValue({
      id: 9,
      name: 'Krell',
      module_count: 2,
      cable_count: 1,
      unresolved_modules: ['Optomix LPG', 'Doepfer A-140'],
    });
    const wrapper = mountView();
    await flushPromises();
    await pick(wrapper, JSON.stringify(DOCUMENT));

    const notice = wrapper.find('[data-test="import-notice"]').text();
    expect(notice).toContain('2 module(s) are not in your racks');
    expect(notice).toContain('Optomix LPG, Doepfer A-140');
  });

  it('refuses a file that is not JSON without asking the server', async () => {
    const wrapper = mountView();
    await flushPromises();
    await pick(wrapper, 'this is a photograph, really', 'holiday.json');

    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="error"]').text()).toContain('not a JSON file');
  });

  it('shows what the server said when it refuses the document', async () => {
    api.post.mockRejectedValue(new Error("unknown format 'something.else'"));
    const wrapper = mountView();
    await flushPromises();
    await pick(wrapper, JSON.stringify({ format: 'something.else' }));

    expect(wrapper.find('[data-test="error"]').text()).toContain('unknown format');
    expect(wrapper.find('[data-test="import-notice"]').exists()).toBe(false);
  });
});
