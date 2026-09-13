import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ push: routerPush, replace: vi.fn() }) };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import CompositionStoryboardView from '../../src/views/CompositionStoryboardView.vue';
import { formatDuration, parseDuration } from '../../src/compositionVocabulary.js';
import { tide } from '../compositionFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// The page reads the composition, and the mapped-patches section reads the
// patch library for its picker.
function answerGets() {
  api.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/compositions/3')) return tide;
    if (path.startsWith('/api/patches')) {
      return { patches: [{ id: 7, name: 'Krell', rack_name: 'main rack' }, { id: 8, name: 'Drone', rack_name: 'main rack' }] };
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

const mountView = () => mount(CompositionStoryboardView, { props: { id: '3' }, global: testGlobal() });

describe('duration words', () => {
  it('reads what a person types and writes it back the same way', () => {
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('2m')).toBe(120);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('soon')).toBeNaN();
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(null)).toBe('');
  });
});

describe('CompositionStoryboardView', () => {
  it('draws the grid: scenes across, parts down, what each does in each', async () => {
    answerGets();
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('Tide');
    expect(wrapper.find('[data-test="composition-blurb"]').text()).toContain('92 BPM');
    const heads = wrapper.findAll('[data-test^="scene-head-"]').map((th) => th.text());
    expect(heads[0]).toContain('Intro');
    expect(heads[0]).toContain('1:30');
    expect(heads[1]).toContain('Build');
    expect(wrapper.find('[data-test="total-duration"]').text()).toContain('1:30');

    expect(wrapper.find('[data-test="cell-10-20"]').text()).toContain('Enters');
    expect(wrapper.find('[data-test="cell-10-20"]').text()).toContain('fade in over 8 bars');
    expect(wrapper.find('[data-test="cell-11-20"]').text()).toContain('Changes');
    // Kick is not playing in the intro.
    expect(wrapper.find('[data-test="cell-10-21"] .cell-button').classes()).toContain('is-empty');
    expect(wrapper.find('[data-test="element-row-21"]').text()).toContain('Rhythm');
  });

  it('writes a cell whole and reads the storyboard back', async () => {
    answerGets();
    api.put.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="cell-10-21"] [data-test="cell-button"]').trigger('click');
    // Not playing in any earlier scene: the likeliest answer is an entrance.
    expect(wrapper.find('[data-test="cell-action"]').element.value).toBe('enter');
    await wrapper.find('[data-test="cell-action"]').setValue('hold');
    await wrapper.find('[data-test="cell-note"]').setValue('quiet, under the wash');
    await wrapper.find('[data-test="cell-11-21"] form, [data-test="cell-10-21"] form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/scenes/10/elements/21', {
      action: 'hold',
      note: 'quiet, under the wash',
    });
    // Two reads: mount, and after the write.
    expect(api.get.mock.calls.filter(([p]) => p === '/api/compositions/3')).toHaveLength(2);
  });

  it('clears a cell the element was playing in', async () => {
    answerGets();
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="cell-11-20"] [data-test="cell-button"]').trigger('click');
    expect(wrapper.find('[data-test="cell-action"]').element.value).toBe('change');
    await wrapper.find('[data-test="cell-clear"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/compositions/3/scenes/11/elements/20');
  });

  it('adds a part and a scene, reading a typed length as seconds', async () => {
    answerGets();
    api.post.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="new-element-name"]').setValue('Wash');
    await wrapper.find('[data-test="new-element-kind"]').setValue('texture');
    await wrapper.find('[data-test="add-element-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/compositions/3/elements', { name: 'Wash', kind: 'texture' });

    await wrapper.find('[data-test="new-scene-name"]').setValue('Drop');
    await wrapper.find('[data-test="new-scene-duration"]').setValue('2:15');
    await wrapper.find('[data-test="add-scene-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/compositions/3/scenes', { name: 'Drop', duration_seconds: 135 });

    // A length nobody can read is refused before anything is sent.
    api.post.mockClear();
    await wrapper.find('[data-test="new-scene-name"]').setValue('Outro');
    await wrapper.find('[data-test="new-scene-duration"]').setValue('a while');
    await wrapper.find('[data-test="add-scene-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="storyboard-error"]').text()).toContain('minutes:seconds');
  });

  it('moves a scene by re-sending the whole order', async () => {
    answerGets();
    api.put.mockResolvedValue([]);
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="scene-head-11"] [data-test="scene-left"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/scenes/order', { scene_ids: [11, 10] });

    await wrapper.find('[data-test="element-row-21"] [data-test="element-up"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/elements/order', { element_ids: [21, 20] });
  });

  it('edits a scene in its heading and an element in its row', async () => {
    answerGets();
    api.put.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="scene-head-10"] [data-test="scene-edit"]').trigger('click');
    expect(wrapper.find('[data-test="scene-duration-input"]').element.value).toBe('1:30');
    await wrapper.find('[data-test="scene-name-input"]').setValue('Opening');
    await wrapper.find('[data-test="scene-duration-input"]').setValue('');
    await wrapper.find('[data-test="scene-head-10"] form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/scenes/10', {
      name: 'Opening',
      duration_seconds: null,
      description: 'just the wash',
    });

    await wrapper.find('[data-test="element-row-20"] [data-test="element-edit"]').trigger('click');
    await wrapper.find('[data-test="element-kind-input"]').setValue('texture');
    await wrapper.find('[data-test="element-row-20"] form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3/elements/20', {
      name: 'Bass',
      kind: 'texture',
      description: '',
    });
  });

  it('deletes a part once confirmed, and not otherwise', async () => {
    answerGets();
    api.delete.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="element-row-21"] [data-test="element-delete"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="element-row-21"] [data-test="element-delete"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/compositions/3/elements/21');
  });

  it('lists the patches it is mapped onto and maps it onto another', async () => {
    answerGets();
    api.post.mockResolvedValue({ id: 41 });
    const wrapper = mountView();
    await flushPromises();

    const row = wrapper.find('[data-test="mapped-7"]');
    expect(row.text()).toContain('Krell');
    expect(row.text()).toContain('1 of 2 parts mapped');
    expect(row.text()).toContain('the small-case version');

    // Krell is already mapped, so only Drone is offered.
    const options = wrapper.findAll('[data-test="map-patch"] option').map((o) => o.text());
    expect(options.some((t) => t.includes('Drone'))).toBe(true);
    expect(options.some((t) => t.includes('Krell'))).toBe(false);

    await wrapper.find('[data-test="map-patch"]').setValue('8');
    await wrapper.find('[data-test="map-form"]').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/compositions/3/patches', { patch_id: 8 });
    expect(routerPush).toHaveBeenCalledWith('/compositions/3/patches/8');
  });

  it('renames and re-describes the composition from its header', async () => {
    answerGets();
    api.put.mockResolvedValue({});
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="composition-edit-button"]').trigger('click');
    await wrapper.find('[data-test="composition-name-input"]').setValue('Tides');
    await wrapper.find('[data-test="composition-tempo-input"]').setValue('');
    await wrapper.find('[data-test="composition-edit"]').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/compositions/3', {
      name: 'Tides',
      description: 'a slow one',
      tempo_bpm: null,
    });
  });
});
