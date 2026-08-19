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
import QuestionsView from '../../src/views/QuestionsView.vue';
import QuestionDetailView from '../../src/views/QuestionDetailView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
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

  it('lists the in-scope modules first and filters both lists by name or manufacturer', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/questions/1')
        return { id: 1, prompt: 'How?', status: 'scoped', modules: [], components: [] };
      if (path === '/api/questions/1/options')
        return {
          modules: [
            { id: 3, manufacturer: '2hp', name: 'Pluck', in_scope: false },
            { id: 4, manufacturer: 'Make Noise', name: 'Maths', in_scope: true },
            { id: 5, manufacturer: 'Mutable', name: 'Plaits', in_scope: false },
          ],
          components: [],
          manuals: [{ id: 11, module_id: 4, name: 'manual', original_name: null, source: 'found' }],
          answers: [],
          notes: [],
        };
      throw new Error(`unexpected ${path}`);
    });

    const wrapper = mount(QuestionDetailView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    // The suggested module comes first even though it is second in the data.
    const labels = () =>
      wrapper.findAll('[data-test="module-option"]').map((b) => b.element.closest('label').textContent.trim());
    expect(labels()[0]).toContain('Maths');

    // Unticking it drops it out of the top list, back among the others.
    const boxes = wrapper.findAll('[data-test="module-option"]');
    await boxes[0].setValue(false);
    expect(labels()[0]).toContain('Pluck');
    expect(wrapper.find('[data-test="review"]').text()).toContain('No modules selected yet.');

    // Filtering narrows the list; every word has to match somewhere.
    await wrapper.find('[data-test="module-filter"]').setValue('mutable pl');
    expect(labels()).toHaveLength(1);
    expect(labels()[0]).toContain('Plaits');

    // A selected module hidden by the filter is still counted as selected.
    await wrapper.findAll('[data-test="module-option"]')[0].setValue(true);
    await wrapper.find('[data-test="module-filter"]').setValue('2hp');
    expect(labels()).toHaveLength(1);
    expect(labels()[0]).toContain('Pluck');
    expect(wrapper.find('[data-test="scope-filter-hidden"]').exists()).toBe(true);

    await wrapper.find('[data-test="clear-module-filter"]').trigger('click');
    expect(labels()).toHaveLength(3);
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
