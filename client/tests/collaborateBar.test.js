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
    useRoute: () => ({ query: {}, path: '/patches/7' }),
  };
});

import { api } from '../src/api.js';
import { useJobsStore } from '../src/stores/jobs.js';
import CollaborateBar from '../src/components/patchdetail/CollaborateBar.vue';
import PatchDetailHeader from '../src/components/patchdetail/PatchDetailHeader.vue';
import PatchDetailView from '../src/views/PatchDetailView.vue';
import PatchDiagram from '../src/components/PatchDiagram.vue';
import { krellPatch } from './patchFixtures.js';

beforeEach(() => vi.clearAllMocks());

const off = { ...krellPatch, collaboration: { enabled: false, prompt: null } };
const on = { ...krellPatch, collaboration: { enabled: true, prompt: 'a slow drone' } };

describe('CollaborateBar', () => {
  const mountIt = (patch) =>
    mount(CollaborateBar, { props: { patch, patchId: '7' }, global: testGlobal() });

  it('switches the mode on with the brief as typed, and hands the answer back to the page', async () => {
    api.put.mockResolvedValue({ id: 7, collaboration: { enabled: true, prompt: 'a slow drone' } });
    const wrapper = mountIt(off);
    expect(wrapper.find('[data-test="collaborate-toggle"]').element.checked).toBe(false);
    expect(wrapper.find('[data-test="collaborate-hint"]').exists()).toBe(true);
    // The brief is only offered once the mode is on...
    expect(wrapper.find('[data-test="collaborate-brief"]').exists()).toBe(false);
    await wrapper.find('[data-test="collaborate-toggle"]').setValue(true);
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/collaboration', { enabled: true, prompt: '' });
    expect(wrapper.emitted('collaboration')).toEqual([[{ enabled: true, prompt: 'a slow drone' }]]);
  });

  it('shows whose move it is, saves the brief, and switches off keeping it', async () => {
    api.put.mockResolvedValue({ id: 7, collaboration: { enabled: true, prompt: 'faster' } });
    const wrapper = mountIt(on);
    expect(wrapper.find('[data-test="collaborate-toggle"]').element.checked).toBe(true);
    expect(wrapper.find('[data-test="collaborate-turn"]').text()).toContain('Your move');
    const brief = wrapper.find('[data-test="collaborate-brief"]');
    expect(brief.element.value).toBe('a slow drone');
    // Nothing to save until the brief changes.
    expect(wrapper.find('[data-test="collaborate-save"]').attributes('disabled')).toBeDefined();
    await brief.setValue(' faster ');
    expect(wrapper.find('[data-test="collaborate-save"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/patches/7/collaboration', { prompt: 'faster' });

    await wrapper.find('[data-test="collaborate-toggle"]').setValue(false);
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith('/api/patches/7/collaboration', { enabled: false });

    // While the model's turn is on the queue, the bar says so.
    const thinking = mountIt({ ...on, generating: true });
    expect(thinking.find('[data-test="collaborate-turn"]').text()).toContain("the model's turn");
  });

  it('says what the model last did on this patch, read off the job feed', async () => {
    const wrapper = mountIt(on);
    const jobs = useJobsStore();
    // Another patch's turn, a progress line of this one, then its move.
    jobs.applyEvent({ kind: 'job', event: 'completed', job: { id: 1, type: 'patch_turn', patch_id: 8 }, message: 'plugged elsewhere' });
    jobs.applyEvent({ kind: 'job', event: 'progress', job: { id: 2, type: 'patch_turn', patch_id: 7 }, message: 'thinking' });
    await flushPromises();
    expect(wrapper.find('[data-test="collaborate-last"]').exists()).toBe(false);
    jobs.applyEvent({
      kind: 'job',
      event: 'completed',
      job: { id: 2, type: 'patch_turn', patch_id: 7 },
      message: 'plugged Ripples "LP" → Outs "In" — so we can hear it',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="collaborate-last"]').text()).toBe(
      'The model plugged Ripples "LP" → Outs "In" — so we can hear it'
    );
    jobs.applyEvent({
      kind: 'job',
      event: 'failed',
      job: { id: 3, type: 'patch_turn', patch_id: 7, error: 'no free input' },
    });
    await flushPromises();
    const last = wrapper.find('[data-test="collaborate-last"]');
    expect(last.text()).toContain('could not move');
    expect(last.classes()).toContain('error');
  });

  it('says so when the server refuses', async () => {
    api.put.mockRejectedValue(new Error('prompt must be 2000 characters or fewer'));
    const wrapper = mountIt(off);
    await wrapper.find('[data-test="collaborate-toggle"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-test="collaborate-error"]').text()).toContain('2000');
    expect(wrapper.emitted('collaboration')).toBeUndefined();
  });
});

describe('the patch page in collaboration mode', () => {
  it('folds the mode into the payload, marks the plug that queued a turn, and re-reads when it lands', async () => {
    api.get.mockResolvedValue(off);
    api.put.mockResolvedValue({ id: 7, collaboration: { enabled: true, prompt: '' } });
    const wrapper = mount(PatchDetailView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="collaborate-toggle"]').setValue(true);
    await flushPromises();
    // One PUT, no re-read of the whole patch for a flag.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-test="collaborate-turn"]').text()).toContain('Your move');

    // The plug answers with the cable, and that the model is now at work.
    const cable = {
      id: 22,
      from_patch_module_id: 11,
      from_component_id: 2,
      from_component_name: 'EOR',
      to_patch_module_id: 13,
      to_component_id: 5,
      to_component_name: 'M1',
    };
    api.post.mockResolvedValue({ ...cable, paired_cable: null, turn: { job_id: 9 }, generating: true });
    wrapper.findComponent(PatchDiagram).vm.$emit('connect', {
      from_patch_module_id: 11,
      from_component_id: 2,
      to_patch_module_id: 13,
      to_component_id: 5,
    });
    await flushPromises();
    expect(api.get).toHaveBeenCalledTimes(1);
    const diagram = wrapper.findComponent(PatchDiagram);
    expect(diagram.props('cables').map((c) => c.id)).toEqual([21, 22]);
    // Neither the turn nor the flag is drawn as part of the cable.
    expect(diagram.props('cables')[1]).toEqual(cable);
    expect(wrapper.find('[data-test="collaborate-turn"]').text()).toContain("the model's turn");
    expect(wrapper.find('[data-test="generating"]').text()).toBe("the model's turn");

    // The turn lands: the page reads the patch with the model's cable in it.
    api.get.mockResolvedValue({ ...on, cables: [...krellPatch.cables, cable, { ...cable, id: 23 }], generating: false });
    const jobs = useJobsStore();
    jobs.finished += 1;
    await flushPromises();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(PatchDiagram).props('cables')).toHaveLength(3);
    expect(wrapper.find('[data-test="generating"]').exists()).toBe(false);
  });

  it('keeps calling the generator’s work generating', () => {
    const wrapper = mount(PatchDetailHeader, {
      props: { patch: { ...off, generating: true }, patchId: '7' },
      global: testGlobal(),
    });
    expect(wrapper.find('[data-test="generating"]').text()).toBe('generating');
  });
});
