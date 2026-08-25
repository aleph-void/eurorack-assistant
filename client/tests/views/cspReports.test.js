// The admin page that reads what browsers refused. Everything on it comes
// from an unauthenticated endpoint that anyone can post to, so the tests below
// care as much about how a hostile value is RENDERED as about the list working.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { openPanels, testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import { dialog } from '../../src/dialog.js';
import CspReportsView from '../../src/views/CspReportsView.vue';

const report = (overrides = {}) => ({
  id: 2,
  disposition: 'enforce',
  directive: 'img-src',
  blocked_uri: 'https://tracker.example/pixel.gif',
  document_uri: 'https://rack.example/modules/12',
  referrer: '',
  source_file: 'https://rack.example/assets/index.js',
  line_number: 12,
  column_number: 4,
  script_sample: '',
  original_policy: "default-src 'self'",
  user_agent: 'Mozilla/5.0 (Chromium)',
  report_count: 3,
  first_seen_at: '2026-01-01T10:00:00.000Z',
  last_seen_at: '2026-01-02T10:00:00.000Z',
  ...overrides,
});

const page = (reports, extra = {}) => ({
  total: reports.length,
  reported: reports.reduce((sum, r) => sum + r.report_count, 0),
  limit: 100,
  has_more: false,
  next_before: null,
  reports,
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe('CspReportsView', () => {
  it('lists what was refused, and how often', async () => {
    api.get.mockResolvedValue(page([report()]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/csp-reports?limit=100');
    const row = wrapper.find('[data-test="report-2"]');
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain('img-src');
    expect(row.text()).toContain('https://tracker.example/pixel.gif');
    // Where in our own code it happened, as one line.
    expect(row.text()).toContain('https://rack.example/assets/index.js:12:4');
    expect(wrapper.find('[data-test="summary"]').text()).toContain('1 distinct violation');
    expect(wrapper.find('[data-test="summary"]').text()).toContain('reported 3 times');
  });

  // A report-only policy is a rehearsal: the browser loaded the thing and only
  // said what it would have done. Reading that row as a break would send an
  // admin chasing a page that works.
  it('says when a violation was only watched, not enforced', async () => {
    api.get.mockResolvedValue(page([report({ disposition: 'report' })]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="report-only"]').exists()).toBe(true);
  });

  // Every value came from an unauthenticated POST. None of it may become
  // markup, and none of it may become a link.
  it('renders a hostile report as text and nothing else', async () => {
    api.get.mockResolvedValue(
      page([
        report({
          blocked_uri: '<img src=x onerror="alert(1)">',
          script_sample: '<script>alert(1)</script>',
          document_uri: 'javascript:alert(1)',
        }),
      ])
    );
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="report-2"]');
    expect(row.text()).toContain('<img src=x onerror="alert(1)">');
    expect(row.find('img').exists()).toBe(false);
    expect(row.find('script').exists()).toBe(false);
    expect(row.find('a').exists()).toBe(false);
  });

  it('holds the browser and the policy back until the row is opened', async () => {
    api.get.mockResolvedValue(page([report()]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Mozilla/5.0 (Chromium)');
    await openPanels(wrapper);
    expect(wrapper.text()).toContain('Mozilla/5.0 (Chromium)');
    expect(wrapper.text()).toContain("default-src 'self'");
  });

  it('fetches the page below the one showing', async () => {
    api.get.mockResolvedValueOnce(
      page([report({ id: 9 })], { total: 2, has_more: true, next_before: 9 })
    );
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    api.get.mockResolvedValueOnce(page([report({ id: 4 })], { total: 2 }));
    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenLastCalledWith('/api/csp-reports?limit=100&before=9');
    expect(wrapper.find('[data-test="report-9"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="report-4"]').exists()).toBe(true);
  });

  it('deletes one report', async () => {
    api.get.mockResolvedValue(page([report()]));
    api.delete.mockResolvedValue({ deleted: 1 });
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/csp-reports/2');
  });

  it('asks before emptying the table, and does nothing if told no', async () => {
    api.get.mockResolvedValue(page([report()]));
    api.delete.mockResolvedValue({ deleted: 1 });
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();

    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    await wrapper.find('[data-test="clear-all"]').trigger('click');
    await flushPromises();
    expect(api.delete).not.toHaveBeenCalled();

    dialog.confirm.mockResolvedValue(true);
    await wrapper.find('[data-test="clear-all"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/api/csp-reports');
  });

  // A browser sends what it knows and no more: Safari omits the column,
  // several omit the source file, and a report can name a directive this
  // build has never heard of. None of that may leave a hole in the row.
  it('draws a report the browser barely filled in', async () => {
    api.get.mockResolvedValue(
      page([
        report({
          directive: '',
          blocked_uri: '',
          document_uri: '',
          referrer: '',
          user_agent: '',
          original_policy: '',
          source_file: '',
          line_number: null,
          column_number: null,
          first_seen_at: null,
          report_count: 1,
        }),
      ])
    );
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    const row = wrapper.find('[data-test="report-2"]');
    expect(row.text()).toContain('unknown');
    expect(row.text()).toContain('—');
    await openPanels(wrapper);
    // A date nothing was recorded for is blank rather than 'Invalid Date'.
    expect(wrapper.text()).not.toContain('Invalid Date');
    // One of each reads as one of each.
    expect(wrapper.find('[data-test="summary"]').text()).toContain('1 distinct violation');
    expect(wrapper.find('[data-test="summary"]').text()).toContain('reported 1 time in all');
  });

  it('counts more than one of them in the plural', async () => {
    api.get.mockResolvedValue(page([report({ id: 2 }), report({ id: 3 })]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="summary"]').text()).toContain('2 distinct violations');
    expect(wrapper.find('[data-test="summary"]').text()).toContain('reported 6 times');
  });

  // The browser gives a column number only when it gives a line, and often
  // gives neither.
  it('names the line only as far as the browser knew it', async () => {
    api.get.mockResolvedValue(
      page([report({ line_number: 12, column_number: null }), report({ id: 3, line_number: null })])
    );
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="report-2"]').text()).toContain(
      'https://rack.example/assets/index.js:12'
    );
    expect(wrapper.find('[data-test="report-2"]').text()).not.toContain(':12:');
    expect(wrapper.find('[data-test="report-3"]').text()).toContain(
      'https://rack.example/assets/index.js'
    );
  });

  // Closing the section leaves what was built in place — the rule the whole
  // app follows for a section that starts closed (lazyPanel.js).
  it('keeps an opened row built after it is closed again', async () => {
    api.get.mockResolvedValue(page([report()]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    await openPanels(wrapper);
    const details = wrapper.find('[data-test="more-2"]');
    details.element.open = false;
    await details.trigger('toggle');
    expect(wrapper.text()).toContain('Mozilla/5.0 (Chromium)');
  });

  // One page at a time: the button says it is working and cannot be pressed
  // again until the page it asked for arrives.
  it('shuts the load-more button while the page it asked for is in flight', async () => {
    api.get.mockResolvedValue(
      page([report({ id: 9 })], { total: 2, has_more: true, next_before: 9 })
    );
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    let deliver;
    api.get.mockReturnValueOnce(
      new Promise((resolve) => {
        deliver = resolve;
      })
    );
    await wrapper.find('[data-test="load-more"]').trigger('click');
    const button = wrapper.find('[data-test="load-more"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Loading');

    deliver(page([report({ id: 4 })], { total: 2 }));
    await flushPromises();
    expect(wrapper.find('[data-test="report-4"]').exists()).toBe(true);
  });

  // Each of the three writes reports its own failure where the reader is
  // looking, rather than leaving the list looking like it did the thing.
  it('says so when a page, a delete or a clear is refused', async () => {
    api.get.mockResolvedValue(page([report()], { total: 2, has_more: true, next_before: 2 }));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();

    api.get.mockRejectedValueOnce(new Error('page is gone'));
    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('page is gone');

    api.delete.mockRejectedValueOnce(new Error('already deleted'));
    await wrapper.find('[data-test="delete-2"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('already deleted');

    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    api.delete.mockRejectedValueOnce(new Error('not yours to clear'));
    await wrapper.find('[data-test="clear-all"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('not yours to clear');
  });

  // Nothing on the page comes from this app: an answer that is not a page of
  // reports is an empty list, not a broken one.
  it('survives an answer with no page in it', async () => {
    api.get.mockResolvedValue(null);
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
  });

  it('says so when nothing has been reported', async () => {
    api.get.mockResolvedValue(page([]));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="report-table"]').exists()).toBe(false);
  });

  it('reports a refusal to load rather than showing an empty page', async () => {
    api.get.mockRejectedValue(new Error('Admin access required'));
    const wrapper = mount(CspReportsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('Admin access required');
  });
});
