import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';
import { splitSnippet } from '../src/snippet.js';

vi.mock('../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

import { api } from '../src/api.js';
import SearchView from '../src/views/SearchView.vue';
import ManualTextView from '../src/views/ManualTextView.vue';
import { routes } from '../src/router.js';

beforeEach(() => {
  vi.clearAllMocks();
  currentRouteQuery = {};
});

const hit = (over = {}) => ({
  manual_id: 1,
  module_id: 7,
  hash: 'a'.repeat(64),
  title: 'Make Noise Maths',
  name: 'manual',
  original_name: 'Make_Noise_Maths_Manual.pdf',
  source: 'found',
  user_id: null,
  manufacturer: 'Make Noise',
  module_name: 'Maths',
  pages: 12,
  chars: 4000,
  rank: 0.4,
  snippet: 'each channel has an [[attenuverter]] on it',
  ...over,
});

describe('splitSnippet', () => {
  it('splits a snippet into plain and matched runs', () => {
    expect(splitSnippet('a [[b]] c')).toEqual([
      { text: 'a ', hit: false },
      { text: 'b', hit: true },
      { text: ' c', hit: false },
    ]);
  });

  it('handles a snippet with no match markers, and an empty one', () => {
    expect(splitSnippet('plain text')).toEqual([{ text: 'plain text', hit: false }]);
    expect(splitSnippet('')).toEqual([]);
    expect(splitSnippet(null)).toEqual([]);
  });
});

describe('SearchView', () => {
  it('searches from the query in the URL and shows ranked hits', async () => {
    currentRouteQuery = { q: 'attenuverter' };
    api.get.mockResolvedValue({
      query: 'attenuverter',
      limit: 20,
      offset: 0,
      has_more: false,
      results: [hit(), hit({ manual_id: 2, user_id: 3, name: 'cheat sheet' })],
    });
    const wrapper = mount(SearchView, { global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith(
      '/api/manuals/search?q=attenuverter&limit=20&offset=0'
    );
    expect(wrapper.find('[data-test="hit-1"]').text()).toContain('Make Noise Maths');
    // The matched word is marked up as an element, never as injected markup.
    const marks = wrapper.find('[data-test="snippet-1"]').findAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].text()).toBe('attenuverter');
    // Your own document says so; the shared manual is labelled as shared.
    expect(wrapper.find('[data-test="hit-1"]').text()).toContain('shared manual');
    expect(wrapper.find('[data-test="hit-2"]').text()).toContain('cheat sheet');
  });

  it('puts a new search in the URL rather than fetching behind the address bar', async () => {
    const wrapper = mount(SearchView, { global: testGlobal() });
    await wrapper.find('[data-test="search-input"]').setValue('gate output');
    await wrapper.find('form').trigger('submit');
    expect(routerPush).toHaveBeenCalledWith({ name: 'search', query: { q: 'gate output' } });
  });

  it('says when nothing matched', async () => {
    currentRouteQuery = { q: 'nothing' };
    api.get.mockResolvedValue({ query: 'nothing', has_more: false, results: [] });
    const wrapper = mount(SearchView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="search-empty"]').text()).toContain('nothing');
  });

  it('appends the next page instead of replacing the results', async () => {
    currentRouteQuery = { q: 'attenuverter' };
    api.get.mockResolvedValueOnce({ has_more: true, query: 'attenuverter', results: [hit()] });
    const wrapper = mount(SearchView, { global: testGlobal() });
    await flushPromises();

    api.get.mockResolvedValueOnce({
      has_more: false,
      query: 'attenuverter',
      results: [hit({ manual_id: 2 })],
    });
    await wrapper.find('[data-test="search-more"]').trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenLastCalledWith(
      '/api/manuals/search?q=attenuverter&limit=20&offset=20'
    );
    expect(wrapper.find('[data-test="hit-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="hit-2"]').exists()).toBe(true);
  });

  it('shows the server\'s error', async () => {
    currentRouteQuery = { q: 'boom' };
    api.get.mockRejectedValue(new Error('Request failed (500)'));
    const wrapper = mount(SearchView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="search-error"]').text()).toContain('Request failed');
  });
});

describe('ManualTextView', () => {
  const document = {
    id: 1,
    manual_id: 1,
    module_id: 7,
    user_id: null,
    hash: 'a'.repeat(64),
    title: 'Make Noise Maths',
    manufacturer: 'Make Noise',
    module_name: 'Maths',
    content: '# Make Noise Maths\n\n## PANEL CONTROLS\n\nEach channel has an *attenuverter*.\n',
    pages: 12,
    chars: 80,
    source: 'pdftotext',
  };

  it('renders the markdown as HTML', async () => {
    api.get.mockResolvedValue(document);
    const wrapper = mount(ManualTextView, { props: { hash: document.hash }, global: testGlobal() });
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith(`/api/manuals/${document.hash}/text`);
    const body = wrapper.find('[data-test="manual-body"]');
    expect(body.find('h2').text()).toBe('PANEL CONTROLS');
    expect(body.find('em').text()).toBe('attenuverter');
    expect(wrapper.find('[data-test="download-markdown"]').attributes('href')).toBe(
      `/api/manuals/${document.hash}/text/export`
    );
  });

  it('strips anything dangerous the PDF put in the text', async () => {
    api.get.mockResolvedValue({
      ...document,
      content: 'Before <img src=x onerror="alert(1)"> after\n',
    });
    const wrapper = mount(ManualTextView, { props: { hash: document.hash }, global: testGlobal() });
    await flushPromises();
    const html = wrapper.find('[data-test="manual-body"]').html();
    expect(html).not.toContain('onerror');
    expect(html).toContain('after');
  });

  it('shows the markdown source on request', async () => {
    api.get.mockResolvedValue(document);
    const wrapper = mount(ManualTextView, { props: { hash: document.hash }, global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="toggle-source"]').trigger('click');
    expect(wrapper.find('[data-test="manual-source"]').text()).toContain('## PANEL CONTROLS');
    expect(wrapper.find('[data-test="manual-body"]').exists()).toBe(false);
  });

  it('reports a document it may not read', async () => {
    api.get.mockRejectedValue(new Error('Document text not found'));
    const wrapper = mount(ManualTextView, { props: { hash: 'b'.repeat(64) }, global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="manual-error"]').text()).toContain('not found');
  });
});

describe('routes', () => {
  it('has a search page and a manual reader', () => {
    const names = routes.map((r) => r.name);
    expect(names).toContain('search');
    expect(names).toContain('manual-text');
    expect(routes.find((r) => r.name === 'manual-text').path).toBe('/manuals/:hash');
  });
});
