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
import { useJobsStore } from '../../src/stores/jobs.js';
import PatchesView from '../../src/views/PatchesView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('PatchesView', () => {
  const racksResponse = [
    { id: 1, name: 'main rack', module_count: 3 },
    { id: 2, name: 'empty case', module_count: 0 },
  ];

  const systemsResponse = [{ id: 7, name: 'studio', rack_count: 2, module_count: 9 }];

  // The patch list arrives as one PAGE of the library, the way the server
  // sends it: rows plus the whole-list count and where the next page starts.
  const asPage = (patches, extra = {}) => ({
    total: patches.length,
    limit: 100,
    has_more: false,
    next_before: null,
    patches,
    ...extra,
  });

  function mockLists(patches, { systems = [], page = {} } = {}) {
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      if (path === '/api/systems') return Promise.resolve(systems);
      return Promise.resolve(asPage(patches, page));
    });
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
    expect(api.get).toHaveBeenCalledWith('/api/patches?limit=100');
  });

  it('pages the list, fetching the next page below the one showing', async () => {
    mockLists(
      [
        { id: 5, name: 'Krell', rack_name: 'main rack', module_count: 3, cable_count: 2, created_at: '2026-08-12T10:00:00Z' },
      ],
      { page: { total: 3, has_more: true, next_before: 5 } }
    );
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="patch-count"]').text()).toContain('Showing 1 of 3');

    mockLists(
      [
        { id: 4, name: 'Drone', rack_name: 'main rack', module_count: 3, cable_count: 1, created_at: '2026-08-11T10:00:00Z' },
        { id: 3, name: 'Bleep', rack_name: 'main rack', module_count: 2, cable_count: 0, created_at: '2026-08-10T10:00:00Z' },
      ],
      { page: { total: 3, has_more: false, next_before: null } }
    );
    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();
    // The next page starts where this one ended, and lands under it.
    expect(api.get).toHaveBeenCalledWith('/api/patches?limit=100&before=5');
    expect(wrapper.findAll('tbody tr').map((r) => r.attributes('data-test'))).toEqual([
      'patch-5',
      'patch-4',
      'patch-3',
    ]);
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false);
  });

  it('creates a patch from the selected rack', async () => {
    mockLists([]);
    api.post.mockResolvedValue({ id: 9 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
    // With no systems, the first rack that actually has modules is preselected.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('rack:1');
    await wrapper.find('[data-test="new-name"]').setValue('Krell');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      rack_id: 1,
      name: 'Krell',
      description: undefined,
    });
  });

  it('creates a patch from a whole system, which is preselected over a rack', async () => {
    mockLists([], { systems: systemsResponse });
    api.post.mockResolvedValue({ id: 10 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    // A system spans every rack in it, so it is the more useful default.
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('system:7');
    await wrapper.find('[data-test="new-name"]').setValue('Whole studio');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches', {
      system_id: 7,
      name: 'Whole studio',
      description: undefined,
    });
  });

  it('names a system patch by its system, with a badge', async () => {
    mockLists(
      [
        {
          id: 5,
          name: 'Whole studio',
          rack_name: 'studio',
          system_id: 7,
          system_name: 'studio',
          module_count: 9,
          cable_count: 4,
          created_at: '2026-08-12T10:00:00Z',
        },
      ],
      { systems: systemsResponse }
    );
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="patch-5"]');
    expect(row.text()).toContain('studio');
    expect(row.find('[data-test="system-badge"]').exists()).toBe(true);
  });

  it('has the model build a patch of the picked source within a cable budget', async () => {
    mockLists([], { systems: systemsResponse });
    api.post.mockResolvedValue({ id: 11, name: 'Evening drone', generating: true, job_id: 3 });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    // The generator's picker follows the same default as a new patch.
    expect(wrapper.find('[data-test="generate-rack"]').element.value).toBe('system:7');
    expect(wrapper.find('[data-test="generate-max-cables"]').element.value).toBe('12');
    await wrapper.find('[data-test="generate-name"]').setValue('Evening drone');
    await wrapper.find('[data-test="generate-max-cables"]').setValue('6');
    await wrapper.find('[data-test="generate-brief"]').setValue('  a slow evolving drone ');
    await wrapper.find('[data-test="generate-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/generate', {
      system_id: 7,
      name: 'Evening drone',
      max_cables: 6,
      prompt: 'a slow evolving drone',
    });
    expect(wrapper.find('[data-test="generate-notice"]').text()).toContain('in the background');
    // The list is re-read so the new row shows up, and the form is cleared
    // for the next one; the budget is a preference and stays.
    expect(api.get).toHaveBeenCalledTimes(6);
    expect(wrapper.find('[data-test="generate-name"]').element.value).toBe('');
    expect(wrapper.find('[data-test="generate-max-cables"]').element.value).toBe('6');
  });

  it('lets the modules of the chosen source be picked, as a request or as the only ones', async () => {
    const modules = [
      { id: 21, manufacturer: 'Make Noise', name: 'Maths', racks: [{ id: 1, name: 'main rack', quantity: 1 }] },
      { id: 22, manufacturer: 'Intellijel', name: 'Outs', racks: [{ id: 1, name: 'main rack', quantity: 1 }] },
      { id: 23, manufacturer: 'ALM', name: 'Pam', racks: [{ id: 2, name: 'empty case', quantity: 1 }] },
    ];
    api.get.mockImplementation((path) => {
      if (path === '/api/racks') return Promise.resolve(racksResponse);
      if (path === '/api/systems') return Promise.resolve([]);
      if (path === '/api/modules') return Promise.resolve(modules);
      return Promise.resolve(asPage([]));
    });
    api.post.mockResolvedValue({ id: 11, name: 'Auto' });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    // The module list is not read until the picker is opened.
    expect(api.get).not.toHaveBeenCalledWith('/api/modules', { quiet: true });
    const picker = wrapper.find('[data-test="generate-modules"]');
    picker.element.open = true;
    await picker.trigger('toggle');
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/modules', { quiet: true });
    // Only the modules of the chosen rack are offered.
    expect(wrapper.find('[data-test="generate-module-21"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="generate-module-23"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="generate-only"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test="generate-module-21"]').setValue(true);
    await wrapper.find('[data-test="generate-only"]').setValue(true);
    expect(wrapper.find('[data-test="generate-modules-count"]').text()).toContain('1 chosen, and only those');
    await wrapper.find('[data-test="generate-name"]').setValue('Just Maths');
    await wrapper.find('[data-test="generate-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/generate', {
      rack_id: 1,
      name: 'Just Maths',
      max_cables: 12,
      prompt: undefined,
      module_ids: [21],
      only_modules: true,
    });
    // The picks are cleared with the rest of the form.
    expect(wrapper.find('[data-test="generate-modules-count"]').exists()).toBe(false);
  });

  it('sends no brief when none was written, and refuses to submit without a name', async () => {
    mockLists([]);
    api.post.mockResolvedValue({ id: 11, name: 'Auto' });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="generate"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="generate-name"]').setValue('Auto');
    expect(wrapper.find('[data-test="generate"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-test="generate-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/patches/generate', {
      rack_id: 1,
      name: 'Auto',
      max_cables: 12,
      prompt: undefined,
    });
  });

  it('opens on the system a Generate Patch button named', async () => {
    // The empty case is nobody's default, so landing on it proves the query
    // was read rather than the default taken.
    currentRouteQuery = { generate: 'rack:2' };
    mockLists([], { systems: systemsResponse });
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="new-rack"]').element.value).toBe('system:7');
    expect(wrapper.find('[data-test="generate-rack"]').element.value).toBe('rack:2');
  });

  it('marks a patch the model is still wiring up and re-reads the list when a job ends', async () => {
    mockLists([
      { id: 5, name: 'Auto', rack_name: 'main rack', module_count: 3, cable_count: 0, generating: true, created_at: '2026-08-12T10:00:00Z' },
      { id: 4, name: 'Krell', rack_name: 'main rack', module_count: 3, cable_count: 2, created_at: '2026-08-11T10:00:00Z' },
    ]);
    const wrapper = mount(PatchesView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="generating-5"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="generating-4"]').exists()).toBe(false);

    // The job lands: the row is read back with its cables.
    mockLists([
      { id: 5, name: 'Auto', rack_name: 'main rack', module_count: 3, cable_count: 6, generating: false, created_at: '2026-08-12T10:00:00Z' },
    ]);
    const jobs = useJobsStore();
    jobs.finished += 1;
    await flushPromises();
    expect(wrapper.find('[data-test="generating-5"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="patch-5"]').text()).toContain('6');

    // With nothing generating, a job ending elsewhere is not this page's news.
    api.get.mockClear();
    jobs.finished += 1;
    await flushPromises();
    expect(api.get).not.toHaveBeenCalled();
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
