// The admin page that reads what the daily backup reported. Every message on
// it is the tail of a host log, so the tests care that it is rendered as
// text, and that the page says plainly which of the three states it is in:
// fine, failed, or never run.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import BackupsView from '../../src/views/BackupsView.vue';

const run = (overrides = {}) => ({
  id: 1,
  status: 'completed',
  name: 'eurorack-backup-20261004-031700Z.tar',
  size_bytes: 734 * 1024 * 1024,
  message: 'uploaded s3://my-backups/eurorack-assistant/eurorack-backup-20261004-031700Z.tar',
  host: 'rack',
  started_at: '2026-10-04T03:17:00.000Z',
  finished_at: '2026-10-04T03:21:12.000Z',
  alerted: false,
  ...overrides,
});

const status = (runs, problem = null) => ({
  latest: runs[0] || null,
  last_completed: runs.find((r) => r.status === 'completed') || null,
  last_failed: runs.find((r) => r.status === 'failed') || null,
  problem,
  runs,
});

beforeEach(() => vi.clearAllMocks());

describe('BackupsView', () => {
  it('says the last backup succeeded and lists the runs', async () => {
    api.get.mockResolvedValue(status([run(), run({ id: 2, finished_at: '2026-10-03T03:20:00.000Z' })]));
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/api/backups', { quiet: true });
    expect(wrapper.find('[data-test="healthy"]').text()).toContain('The last backup succeeded');
    expect(wrapper.find('[data-test="problem"]').exists()).toBe(false);
    const rows = wrapper.findAll('[data-test="run-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('734.0 MB');
    expect(rows[0].text()).toContain('rack');
    expect(wrapper.find('[data-test="status-1"]').classes()).toContain('completed');
  });

  it('leads with the failure, shows what the script said as text, and points at the config when nobody was mailed', async () => {
    const failed = run({
      id: 3,
      status: 'failed',
      size_bytes: null,
      message: 'upload failed: <b>AccessDenied</b>\nno space left on device',
      alerted: false,
    });
    api.get.mockResolvedValue(status([failed, run()], 'The last backup failed on Sun, 04 Oct 2026 03:21:12 GMT.'));
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="problem"]').text()).toContain('The last backup failed');
    expect(wrapper.find('[data-test="last-good"]').text()).toContain('eurorack-backup-20261004-031700Z.tar');
    expect(wrapper.find('[data-test="unalerted"]').exists()).toBe(true);
    const message = wrapper.find('[data-test="run-3"] pre');
    expect(message.text()).toContain('<b>AccessDenied</b>');
    expect(message.find('b').exists()).toBe(false);
    expect(wrapper.find('[data-test="status-3"]').classes()).toContain('failed');
  });

  it('says so when a failure was mailed', async () => {
    api.get.mockResolvedValue(
      status([run({ id: 4, status: 'failed', alerted: true, message: 'boom' })], 'The last backup failed.')
    );
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="unalerted"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="run-4"]').text()).toContain('alert mailed');
  });

  it('explains how to turn backups on when none has ever reported', async () => {
    api.get.mockResolvedValue(status([]));
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="never"]').text()).toContain('install-backup.sh');
    expect(wrapper.find('[data-test="run-table"]').exists()).toBe(false);
  });

  it('reloads on demand', async () => {
    api.get.mockResolvedValue(status([]));
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    api.get.mockResolvedValue(status([run()]));
    await wrapper.find('[data-test="reload"]').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-test="healthy"]').exists()).toBe(true);
  });

  it('says when the status could not be read', async () => {
    api.get.mockRejectedValue(new Error('Forbidden'));
    const wrapper = mount(BackupsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="unavailable"]').exists()).toBe(true);
  });
});
