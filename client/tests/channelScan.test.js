import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../src/api.js';
import ChannelScanPanel from '../src/components/ChannelScanPanel.vue';

beforeEach(() => {
  vi.clearAllMocks();
});

const scanResponse = {
  channel: { id: 'UCx', title: 'Synth Channel', url: 'https://www.youtube.com/channel/UCx' },
  scanned: 40,
  modules: [
    {
      module_id: 1,
      manufacturer: 'Make Noise',
      name: 'Maths',
      videos: [
        {
          video_id: 'AAAAAAAAAA1',
          url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1',
          title: 'Maths tutorial',
          published_at: '2026-01-05T00:00:00Z',
          matched_on: 'title',
          already_attached: false,
        },
        {
          video_id: 'AAAAAAAAAA2',
          url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2',
          title: 'Ambient jam',
          published_at: '2026-01-02T00:00:00Z',
          matched_on: 'description',
          already_attached: true,
        },
      ],
    },
    {
      module_id: 2,
      manufacturer: 'Mutable Instruments',
      name: 'Plaits',
      videos: [
        {
          video_id: 'AAAAAAAAAA3',
          url: 'https://www.youtube.com/watch?v=AAAAAAAAAA3',
          title: 'Plaits deep dive',
          published_at: '2026-01-03T00:00:00Z',
          matched_on: 'title',
          already_attached: false,
        },
      ],
    },
  ],
};

async function scannedWrapper() {
  api.post.mockResolvedValueOnce(scanResponse);
  const wrapper = mount(ChannelScanPanel, { props: { rackId: 7 }, global: testGlobal() });
  await wrapper.find('[data-test="channel-url"]').setValue('https://www.youtube.com/@synthchan');
  await wrapper.find('[data-test="channel-scan-button"]').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('ChannelScanPanel', () => {
  it('scans a channel and lists the matches grouped by module, importables pre-selected', async () => {
    const wrapper = await scannedWrapper();
    expect(api.post).toHaveBeenCalledWith('/api/racks/7/videos/channel-scan', {
      url: 'https://www.youtube.com/@synthchan',
    });
    expect(wrapper.find('[data-test="channel-scan-summary"]').text()).toContain('Scanned 40 video(s)');
    expect(wrapper.find('[data-test="channel-scan-summary"]').text()).toContain('3 match(es) across 2 module(s)');

    const maths = wrapper.find('[data-test="scan-module-1"]');
    expect(maths.text()).toContain('Make Noise Maths');
    expect(maths.text()).toContain('matched in description');
    // The two importable videos start ticked; the attached one is disabled.
    expect(wrapper.find('[data-test="pick-1-AAAAAAAAAA1"]').element.checked).toBe(true);
    expect(wrapper.find('[data-test="pick-2-AAAAAAAAAA3"]').element.checked).toBe(true);
    const attached = wrapper.find('[data-test="pick-1-AAAAAAAAAA2"]');
    expect(attached.element.disabled).toBe(true);
    expect(wrapper.find('[data-test="attached-1-AAAAAAAAAA2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="import-selected"]').text()).toContain('Import 2 selected');
  });

  it('select none / select all and single toggles adjust the import set', async () => {
    const wrapper = await scannedWrapper();
    await wrapper.find('[data-test="select-none"]').trigger('click');
    expect(wrapper.find('[data-test="pick-1-AAAAAAAAAA1"]').element.checked).toBe(false);
    expect(wrapper.find('[data-test="import-selected"]').element.disabled).toBe(true);

    await wrapper.find('[data-test="pick-2-AAAAAAAAAA3"]').setValue(true);
    expect(wrapper.find('[data-test="import-selected"]').text()).toContain('Import 1 selected');

    await wrapper.find('[data-test="select-all"]').trigger('click');
    expect(wrapper.find('[data-test="import-selected"]').text()).toContain('Import 2 selected');
  });

  it('imports the selection and marks the queued videos as attached', async () => {
    const wrapper = await scannedWrapper();
    await wrapper.find('[data-test="pick-1-AAAAAAAAAA1"]').setValue(false);
    api.post.mockResolvedValueOnce({ queued: 1, skipped: 0, videos: [] });
    await wrapper.find('[data-test="import-selected"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/api/racks/7/videos/import', {
      videos: [{ module_id: 2, video_id: 'AAAAAAAAAA3', title: 'Plaits deep dive' }],
    });
    expect(wrapper.find('[data-test="channel-scan-notice"]').text()).toContain('Queued 1 video(s)');
    // The imported video now reads as attached and cannot be re-picked.
    expect(wrapper.find('[data-test="pick-2-AAAAAAAAAA3"]').element.disabled).toBe(true);
    expect(wrapper.find('[data-test="import-selected"]').element.disabled).toBe(true);
  });

  it('shows scan errors and the empty-match state', async () => {
    api.post.mockRejectedValueOnce(new Error('No YouTube API key is configured'));
    const wrapper = mount(ChannelScanPanel, { props: { rackId: 7 }, global: testGlobal() });
    await wrapper.find('[data-test="channel-url"]').setValue('@synthchan');
    await wrapper.find('[data-test="channel-scan-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="channel-scan-error"]').text()).toContain('No YouTube API key');

    api.post.mockResolvedValueOnce({ ...scanResponse, modules: [] });
    await wrapper.find('[data-test="channel-scan-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="channel-scan-empty"]').exists()).toBe(true);
  });

  it('resets the scan when the rack changes', async () => {
    const wrapper = await scannedWrapper();
    await wrapper.setProps({ rackId: 8 });
    expect(wrapper.find('[data-test="channel-scan-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="channel-url"]').element.value).toBe('');
  });
});
