import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../src/api.js';
import MailSettingsView from '../../src/views/MailSettingsView.vue';

beforeEach(() => {
  vi.clearAllMocks();
});

const empty = {
  mail_host: '',
  mail_port: 587,
  mail_secure: false,
  mail_user: '',
  mail_password_set: false,
  mail_from: '',
  public_url: '',
  problem: 'the SMTP host is not set',
  settings: [],
};

const configured = {
  ...empty,
  mail_host: 'smtp.example.org',
  mail_port: 465,
  mail_secure: true,
  mail_user: 'rack',
  mail_password_set: true,
  mail_from: 'rack@example.org',
  public_url: 'https://rack.example.org',
  problem: null,
};

describe('MailSettingsView', () => {
  it('says what is missing and saves the settings, sending the password only when typed', async () => {
    api.get.mockResolvedValue(empty);
    api.put.mockResolvedValue(configured);
    const wrapper = mount(MailSettingsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="problem"]').text()).toContain('SMTP host');
    expect(wrapper.find('[data-test="send-test"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test="host"]').setValue('smtp.example.org');
    await wrapper.find('[data-test="port"]').setValue('465');
    await wrapper.find('[data-test="secure"]').setValue(true);
    await wrapper.find('[data-test="user"]').setValue('rack');
    await wrapper.find('[data-test="from"]').setValue('rack@example.org');
    await wrapper.find('[data-test="public-url"]').setValue('https://rack.example.org');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config/mail', {
      mail_host: 'smtp.example.org',
      mail_port: 465,
      mail_secure: true,
      mail_user: 'rack',
      mail_from: 'rack@example.org',
      public_url: 'https://rack.example.org',
    });
    expect(wrapper.find('[data-test="saved"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="problem"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="password-set"]').exists()).toBe(true);

    await wrapper.find('[data-test="password"]').setValue('hunter2');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.put.mock.calls[1][1].mail_password).toBe('hunter2');
    // The box never shows what was sent.
    expect(wrapper.find('[data-test="password"]').element.value).toBe('');
  });

  it('removes the kept password and sends a test mail', async () => {
    api.get.mockResolvedValue(configured);
    api.put.mockResolvedValue({ ...configured, mail_password_set: false });
    api.post.mockResolvedValue({ ok: true, to: 'admin@example.org' });
    const wrapper = mount(MailSettingsView, { global: testGlobal() });
    await flushPromises();
    expect(wrapper.find('[data-test="host"]').element.value).toBe('smtp.example.org');
    expect(wrapper.find('[data-test="secure"]').element.checked).toBe(true);

    await wrapper.find('[data-test="clear-password"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/config/mail', { mail_password: '' });
    expect(wrapper.find('[data-test="clear-password"]').exists()).toBe(false);

    await wrapper.find('[data-test="send-test"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/api/config/mail/test');
    expect(wrapper.find('[data-test="tested"]').text()).toContain('admin@example.org');
  });

  it('shows the server\'s refusal', async () => {
    api.get.mockResolvedValue(configured);
    api.put.mockRejectedValue(new Error('Invalid mail_port: a port number from 1 to 65535'));
    const wrapper = mount(MailSettingsView, { global: testGlobal() });
    await flushPromises();
    await wrapper.find('[data-test="port"]').setValue('70000');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('mail_port');
  });
});
