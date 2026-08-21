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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/documents' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleDocumentsView from '../../src/views/ModuleDocumentsView.vue';
import DocumentsSection from '../../src/components/moduledetail/DocumentsSection.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { mathsModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleDocumentsView', () => {
  const moduleResponse = mathsModule;

  it('links a document with extracted text to the reader, and says so when there is none', async () => {
    api.get.mockResolvedValue(moduleResponse);
    const wrapper = mount(ModuleDocumentsView, { props: { id: '1' }, global: testGlobal() });
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

  it('lists documents; only own uploads are removable', async () => {
    // The removals below now go through the confirm modal.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(moduleResponse);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleDocumentsView, { props: { id: '1' }, global: testGlobal() });
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

  it('uploads an additional PDF as base64 with a required name', async () => {
    api.get.mockResolvedValue(moduleResponse);
    api.post.mockResolvedValue({ id: 3 });
    const wrapper = mount(ModuleDocumentsView, { props: { id: '1' }, global: testGlobal() });
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
    const wrapper = mount(ModuleDocumentsView, { props: { id: '1' }, global: testGlobal() });
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
