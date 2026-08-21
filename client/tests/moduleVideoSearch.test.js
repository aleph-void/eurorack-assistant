import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
import VideoSearchPanel from '../src/components/moduledetail/VideoSearchPanel.vue';

beforeEach(() => {
  vi.clearAllMocks();
});

const searchResponse = {
  query: 'Make Noise Maths eurorack',
  source: 'api',
  next_page: 'page-1',
  videos: [
    {
      video_id: 'AAAAAAAAAA1',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1',
      title: 'Maths tutorial',
      channel: 'Synth Channel',
      published_at: '2026-01-05T00:00:00Z',
      already_attached: false,
      attached_status: null,
    },
    {
      video_id: 'AAAAAAAAAA2',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2',
      title: 'Maths ambient jam',
      channel: 'Synth Channel',
      published_at: '2026-01-02T00:00:00Z',
      already_attached: true,
      attached_status: 'complete',
    },
    {
      video_id: 'AAAAAAAAAA3',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA3',
      title: 'Maths quadrature tricks',
      channel: 'Other Channel',
      published_at: '2026-01-01T00:00:00Z',
      already_attached: false,
      attached_status: 'failed',
    },
  ],
};

async function searchedWrapper() {
  // Cloned per test: the panel mutates the result after an import.
  api.post.mockResolvedValueOnce(structuredClone(searchResponse));
  const wrapper = mount(VideoSearchPanel, { props: { moduleId: '5' }, global: testGlobal() });
  await wrapper.find('[data-test="video-search-button"]').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('VideoSearchPanel', () => {
  it('searches YouTube and lists the results, nothing pre-selected', async () => {
    const wrapper = await searchedWrapper();
    expect(api.post).toHaveBeenCalledWith('/api/modules/5/videos/search', {});
    expect(wrapper.find('[data-test="video-search-summary"]').text()).toContain(
      'Make Noise Maths eurorack'
    );
    // Nothing starts ticked — importing is always a deliberate choice. The
    // analyzed video is disabled with its status, and the earlier failure is
    // offered again with its own badge.
    expect(wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').element.checked).toBe(false);
    const attached = wrapper.find('[data-test="search-pick-AAAAAAAAAA2"]');
    expect(attached.element.disabled).toBe(true);
    expect(wrapper.find('[data-test="search-attached-AAAAAAAAAA2"]').text()).toBe('analyzed');
    const failed = wrapper.find('[data-test="search-pick-AAAAAAAAAA3"]');
    expect(failed.element.disabled).toBe(false);
    expect(failed.element.checked).toBe(false);
    expect(wrapper.find('[data-test="search-attached-AAAAAAAAAA3"]').text()).toBe(
      'failed last time'
    );
    expect(wrapper.find('[data-test="search-import-selected"]').element.disabled).toBe(true);
    // The keyless note only shows for yt-dlp answers.
    expect(wrapper.find('[data-test="video-search-keyless"]').exists()).toBe(false);
  });

  it('select all / select none and single toggles adjust the import set', async () => {
    const wrapper = await searchedWrapper();
    await wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').setValue(true);
    expect(wrapper.find('[data-test="search-import-selected"]').text()).toContain(
      'Import 1 selected'
    );

    // Select-all covers the failed one too — the retry is a deliberate pick.
    await wrapper.find('[data-test="search-select-all"]').trigger('click');
    expect(wrapper.find('[data-test="search-import-selected"]').text()).toContain(
      'Import 2 selected'
    );
    expect(wrapper.find('[data-test="search-pick-AAAAAAAAAA3"]').element.checked).toBe(true);

    await wrapper.find('[data-test="search-select-none"]').trigger('click');
    expect(wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').element.checked).toBe(false);
    expect(wrapper.find('[data-test="search-import-selected"]').element.disabled).toBe(true);
  });

  it('loads the next page and appends it without duplicates', async () => {
    const wrapper = await searchedWrapper();
    api.post.mockResolvedValueOnce({
      query: 'Make Noise Maths eurorack',
      source: 'api',
      next_page: null,
      videos: [
        structuredClone(searchResponse.videos[0]), // overlaps the first page
        {
          video_id: 'AAAAAAAAAA4',
          url: 'https://www.youtube.com/watch?v=AAAAAAAAAA4',
          title: 'Maths deep dive',
          channel: 'Synth Channel',
          published_at: '2025-12-01T00:00:00Z',
          already_attached: false,
          attached_status: null,
        },
      ],
    });
    await wrapper.find('[data-test="video-search-more"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/modules/5/videos/search', { page: 'page-1' });
    expect(wrapper.findAll('.search-videos li')).toHaveLength(4);
    // The last page: no more button.
    expect(wrapper.find('[data-test="video-search-more"]').exists()).toBe(false);
  });

  it('imports the selection, marks it attached and tells the parent to reload', async () => {
    const wrapper = await searchedWrapper();
    await wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').setValue(true);
    api.post.mockResolvedValueOnce({ queued: 1, skipped: 0, videos: [] });
    await wrapper.find('[data-test="search-import-selected"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/modules/5/videos/import', {
      videos: [{ video_id: 'AAAAAAAAAA1', title: 'Maths tutorial' }],
    });
    expect(wrapper.find('[data-test="video-search-notice"]').text()).toContain('Queued 1 video');
    const imported = wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]');
    expect(imported.element.disabled).toBe(true);
    expect(wrapper.find('[data-test="search-attached-AAAAAAAAAA1"]').text()).toBe('in progress');
    expect(wrapper.emitted('imported')).toHaveLength(1);
  });

  it('goes back to the unsearched view when the module changes', async () => {
    const wrapper = await searchedWrapper();
    await wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').setValue(true);
    expect(wrapper.find('[data-test="video-search-summary"]').exists()).toBe(true);

    // Previous/Next keeps the panel mounted and only swaps the id.
    await wrapper.setProps({ moduleId: '6' });
    await flushPromises();
    expect(wrapper.find('[data-test="video-search-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="search-pick-AAAAAAAAAA1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="video-search-button"]').text()).toBe('Search YouTube');

    // And the new module searches for itself.
    api.post.mockResolvedValueOnce(structuredClone(searchResponse));
    await wrapper.find('[data-test="video-search-button"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/modules/6/videos/search', {});
  });

  it('drops a search that lands after the reader has walked on', async () => {
    let settle;
    api.post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const wrapper = mount(VideoSearchPanel, { props: { moduleId: '5' }, global: testGlobal() });
    await wrapper.find('[data-test="video-search-button"]').trigger('click');
    await wrapper.setProps({ moduleId: '6' });
    settle(structuredClone(searchResponse));
    await flushPromises();

    // The hits belong to module 5 and must not appear under module 6.
    expect(wrapper.find('[data-test="video-search-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="video-search-button"]').text()).toBe('Search YouTube');
  });

  it('explains keyless results and shows search errors', async () => {
    api.post.mockResolvedValueOnce({
      query: 'Make Noise Maths eurorack',
      source: 'yt-dlp',
      next_page: null,
      videos: [],
    });
    const wrapper = mount(VideoSearchPanel, { props: { moduleId: '5' }, global: testGlobal() });
    await wrapper.find('[data-test="video-search-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="video-search-keyless"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="video-search-empty"]').exists()).toBe(true);

    api.post.mockRejectedValueOnce(new Error('the YouTube API key is over its daily quota'));
    await wrapper.find('[data-test="video-search-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="video-search-error"]').text()).toContain('daily quota');
  });
});
