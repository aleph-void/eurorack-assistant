import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import ResourceLinks from '../../src/components/ResourceLinks.vue';

const thread = {
  id: 2,
  module_id: 1,
  url: 'https://modwiggler.com/forum/t?p=1',
  title: 'Firmware thread',
  description: 'the 2.1 changes',
  position: 0,
};
const manual = {
  id: 3,
  module_id: 1,
  url: 'https://example.org/manual',
  title: null,
  description: null,
  position: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

const mountFor = (kind, recordId = '1') =>
  mount(ResourceLinks, { props: { kind, recordId }, global: testGlobal() });

describe('ResourceLinks', () => {
  it('asks for the links of whichever record it is on', async () => {
    api.get.mockResolvedValue([]);
    for (const [kind, query] of [
      ['module', 'module_id=1'],
      ['patch', 'patch_id=1'],
      ['rack', 'rack_id=1'],
      ['system', 'system_id=1'],
    ]) {
      mountFor(kind);
      await flushPromises();
      expect(api.get).toHaveBeenCalledWith(`/api/links?${query}`);
    }
  });

  it('lists links, showing where each one actually goes', async () => {
    api.get.mockResolvedValue([thread, manual]);
    const wrapper = mountFor('module');
    await flushPromises();

    const row = wrapper.find('[data-test="link-2"]');
    expect(row.text()).toContain('Firmware thread');
    expect(row.text()).toContain('the 2.1 changes');
    const anchor = row.find('a');
    expect(anchor.attributes('href')).toBe(thread.url);
    // A tab handed the page can otherwise steer the one it came from.
    expect(anchor.attributes('target')).toBe('_blank');
    expect(anchor.attributes('rel')).toBe('noopener noreferrer');
    // A link with no title of its own still says where it goes.
    expect(wrapper.find('[data-test="link-3"]').text()).toContain('https://example.org/manual');
  });

  it('adds a link and clears the form', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue(thread);
    const wrapper = mountFor('rack', '4');
    await flushPromises();

    await wrapper.find('[data-test="link-url"]').setValue('modwiggler.com/forum/t?p=1');
    await wrapper.find('[data-test="link-title"]').setValue('Firmware thread');
    await wrapper.find('[data-test="link-description"]').setValue('the 2.1 changes');
    await wrapper.find('[data-test="link-form"]').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/api/links', {
      rack_id: 4,
      url: 'modwiggler.com/forum/t?p=1',
      title: 'Firmware thread',
      description: 'the 2.1 changes',
    });
    expect(wrapper.find('[data-test="link-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="link-url"]').element.value).toBe('');
  });

  it('says what the server refused instead of losing it', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockRejectedValue(new Error('Links must be http:// or https:// addresses'));
    const wrapper = mountFor('module');
    await flushPromises();

    await wrapper.find('[data-test="link-url"]').setValue('javascript:alert(1)');
    await wrapper.find('[data-test="link-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('http://');
  });

  it('edits a link in place', async () => {
    api.get.mockResolvedValue([thread]);
    api.put.mockResolvedValue({ ...thread, title: 'Firmware 2.1' });
    const wrapper = mountFor('module');
    await flushPromises();

    await wrapper.find('[data-test="link-edit"]').trigger('click');
    await wrapper.find('[data-test="link-edit-title"]').setValue('Firmware 2.1');
    await wrapper.find('[data-test="link-edit-description"]').setValue('what 2.1 changed');
    await wrapper.find('[data-test="link-save"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/links/2', {
      url: thread.url,
      title: 'Firmware 2.1',
      description: 'what 2.1 changed',
    });
    expect(wrapper.find('[data-test="link-2"]').text()).toContain('Firmware 2.1');
  });

  // Moving one link writes every position, so the order is what the user
  // arranged rather than whatever the two swapped rows happened to hold.
  it('reorders links and writes both positions', async () => {
    api.get.mockResolvedValue([thread, manual]);
    api.put.mockResolvedValue({});
    const wrapper = mountFor('module');
    await flushPromises();

    await wrapper.findAll('[data-test="link-down"]')[0].trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/links/3', { position: 0 });
    expect(api.put).toHaveBeenCalledWith('/api/links/2', { position: 1 });
    expect(wrapper.findAll('tbody tr')[0].text()).toContain('example.org/manual');
  });

  it('deletes a link', async () => {
    api.get.mockResolvedValue([thread]);
    api.delete.mockResolvedValue({ ok: true });
    const wrapper = mountFor('system', '6');
    await flushPromises();

    await wrapper.find('[data-test="link-delete"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/links/2');
    expect(wrapper.find('[data-test="no-links"]').exists()).toBe(true);
  });
});

describe('ResourceLinks, when things go wrong or move', () => {
  it('says why the list could not be read', async () => {
    api.get.mockRejectedValue(new Error('Record not found'));
    const wrapper = mountFor('rack', '9');
    await flushPromises();
    expect(wrapper.find('[data-test="links-list-error"]').text()).toContain('Record not found');
  });

  it('says what an edit was refused for and keeps the row open', async () => {
    api.get.mockResolvedValue([thread]);
    api.put.mockRejectedValue(new Error('That is not a URL'));
    const wrapper = mountFor('module');
    await flushPromises();

    await wrapper.find('[data-test="link-edit"]').trigger('click');
    await wrapper.find('[data-test="link-edit-url"]').setValue('not a url');
    await wrapper.find('[data-test="link-save"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="link-error"]').text()).toContain('not a URL');
    expect(wrapper.find('[data-test="link-edit-url"]').exists()).toBe(true);
  });

  it('backs out of an edit without writing anything', async () => {
    api.get.mockResolvedValue([thread]);
    const wrapper = mountFor('module');
    await flushPromises();

    await wrapper.find('[data-test="link-edit"]').trigger('click');
    await wrapper.find('[data-test="link-edit-title"]').setValue('half a thought');
    await wrapper.findAll('[data-test="link-2"] button')[1].trigger('click');
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="link-2"]').text()).toContain('Firmware thread');
  });

  it('moves a link up, and will not move the ends off the list', async () => {
    api.get.mockResolvedValue([thread, manual]);
    api.put.mockResolvedValue({});
    const wrapper = mountFor('module');
    await flushPromises();

    // The first row cannot go up and the last cannot go down.
    expect(wrapper.findAll('[data-test="link-up"]')[0].attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('[data-test="link-down"]')[1].attributes('disabled')).toBeDefined();

    await wrapper.findAll('[data-test="link-up"]')[1].trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/links/3', { position: 0 });
    expect(wrapper.findAll('tbody tr')[0].text()).toContain('example.org/manual');
  });

  // An order the server refused is not the order: the list is read back
  // rather than left showing a move that did not happen.
  it('re-reads the list when the new order could not be saved', async () => {
    api.get.mockResolvedValue([thread, manual]);
    api.put.mockRejectedValue(new Error('Request failed (500)'));
    const wrapper = mountFor('module');
    await flushPromises();
    api.get.mockClear();

    await wrapper.findAll('[data-test="link-down"]')[0].trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/links?module_id=1');
    expect(wrapper.findAll('tbody tr')[0].text()).toContain('Firmware thread');
  });

  it('reads the new record when the panel is pointed at another one', async () => {
    api.get.mockResolvedValue([]);
    const wrapper = mountFor('rack', '4');
    await flushPromises();
    await wrapper.setProps({ recordId: '5' });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/links?rack_id=5');
  });
});
