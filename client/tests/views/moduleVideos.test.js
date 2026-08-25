import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

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
    useRoute: () => ({ query: currentRouteQuery, path: '/modules/1/videos' }),
  };
});

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import ModuleVideosView from '../../src/views/ModuleVideosView.vue';
import { refreshRackModules } from '../../src/components/moduledetail/useModuleRecord.js';
import { videosModule } from '../moduleFixtures.js';

beforeEach(() => {
  // The list of the user's modules is kept for the session by every module
  // page (useModuleRecord.js), so each test starts without the last one's.
  refreshRackModules();
  vi.clearAllMocks();
  currentRouteQuery = {};
});

describe('ModuleVideosView', () => {
  const moduleResponse = videosModule;

  it('lists the videos with status, rendered summary, progress and failure notes', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    const row = wrapper.find('[data-test="video-5"]');
    expect(row.text()).toContain('Maths tricks');
    expect(row.text()).toContain('Synth Channel');
    expect(row.text()).toContain('5 min');
    expect(row.find('a').attributes('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(wrapper.find('[data-test="video-status-5"]').text()).toBe('complete');
    // The summary is markdown, rendered (and sanitized) to HTML.
    expect(wrapper.find('[data-test="video-summary-5"] h2').text()).toBe('Slew plucks');

    // A video mid-pipeline says so; its link falls back to the URL.
    const pending = wrapper.find('[data-test="video-6"]');
    expect(pending.find('a').text()).toContain('youtube.com/watch?v=AAAAAAAAAAA');
    expect(wrapper.find('[data-test="video-working-6"]').exists()).toBe(true);

    // A failed one shows the error and offers a retry.
    expect(wrapper.find('[data-test="video-error-7"]').text()).toContain('video unavailable');
    expect(wrapper.find('[data-test="retry-video-7"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="retry-video-5"]').exists()).toBe(false);
  });

  it('attaches a YouTube link and reloads', async () => {
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), videos: [] });
    api.post.mockResolvedValue({ id: 9, job_id: 4 });
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('[data-test="video-send"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="video-url"]').setValue('https://youtu.be/dQw4w9WgXcQ');
    expect(wrapper.find('[data-test="video-send"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-test="video-send"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/videos', {
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(wrapper.find('[data-test="video-url"]').element.value).toBe('');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/modules/1').length).toBeGreaterThan(1);
  });

  it('shows the server refusal for a link that is not a video', async () => {
    api.get.mockResolvedValue({ ...structuredClone(moduleResponse), videos: [] });
    api.post.mockRejectedValue(new Error('url must be a link to a YouTube video'));
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="video-url"]').setValue('https://vimeo.com/123');
    await wrapper.find('[data-test="video-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="video-add-error"]').text()).toContain('YouTube');
  });

  it('retries a failed video by re-posting its URL', async () => {
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.post.mockResolvedValue({ id: 7, job_id: 8 });
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="retry-video-7"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/modules/1/videos', {
      url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
    });
  });

  it('shows the oscilloscope clips with their panes, saves a caption and deletes one', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.put.mockResolvedValue({ ok: true });
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);

    const clip = wrapper.find('[data-test="clip-12"]');
    expect(clip.text()).toContain('EOR rising');
    expect(clip.text()).toContain('recorded on patch “Krell”');
    expect(clip.find('[data-test="clip-video-12"]').attributes('src')).toBe('/api/clips/12/video');
    // Each pane says what it was showing at record time.
    expect(clip.text()).toContain('Make Noise Maths — EOR');
    expect(clip.text()).toContain('patched from Make Noise Maths EOR');

    await wrapper.find('[data-test="clip-caption-12"]').setValue('slow rise');
    await wrapper.find('[data-test="clip-save-12"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/clips/12', { caption: 'slow rise' });

    confirm.mockResolvedValue(false);
    await wrapper.find('[data-test="clip-delete-12"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="clip-delete-12"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/clips/12');
  });

  it('removes a video after confirming, and not without', async () => {
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    api.get.mockResolvedValue(structuredClone(moduleResponse));
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mount(ModuleVideosView, { props: { id: '1' }, global: testGlobal() });
    await flushPromises();

    await wrapper.find('[data-test="delete-video-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="delete-video-5"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/modules/1/videos/5');
  });
});
