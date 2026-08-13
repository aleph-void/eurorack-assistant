import { describe, it, expect, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from './setup.js';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import { dialog, dialogState, settleConfirm } from '../src/dialog.js';

afterEach(() => settleConfirm(false));

const ask = (overrides = {}) =>
  dialog.confirm({ title: 'Delete patch', message: 'Its cables are lost.', ...overrides });

describe('ConfirmDialog', () => {
  it('stays out of the page until something is asked', () => {
    const wrapper = mount(ConfirmDialog, { global: testGlobal(), attachTo: document.body });
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(false);
  });

  it('shows the question and resolves true when confirmed', async () => {
    const wrapper = mount(ConfirmDialog, { global: testGlobal(), attachTo: document.body });
    const answer = ask({ confirmLabel: 'Delete', danger: true });
    await flushPromises();

    expect(wrapper.find('[data-test="confirm-title"]').text()).toBe('Delete patch');
    expect(wrapper.find('[data-test="confirm-message"]').text()).toBe('Its cables are lost.');
    const ok = wrapper.find('[data-test="confirm-ok"]');
    expect(ok.text()).toBe('Delete');
    expect(ok.classes()).toContain('danger');
    // The action is under the cursor, so Enter answers it.
    expect(document.activeElement).toBe(ok.element);

    await ok.trigger('click');
    expect(await answer).toBe(true);
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(false);
  });

  it('resolves false when cancelled, and by default is not destructive', async () => {
    const wrapper = mount(ConfirmDialog, { global: testGlobal(), attachTo: document.body });
    const answer = ask();
    await flushPromises();

    expect(wrapper.find('[data-test="confirm-ok"]').classes()).not.toContain('danger');
    expect(wrapper.find('[data-test="confirm-cancel"]').text()).toBe('Cancel');
    await wrapper.find('[data-test="confirm-cancel"]').trigger('click');
    expect(await answer).toBe(false);
  });

  it('treats a click on the backdrop and Escape as declining', async () => {
    const wrapper = mount(ConfirmDialog, { global: testGlobal(), attachTo: document.body });
    const backdropAnswer = ask();
    await flushPromises();
    await wrapper.find('[data-test="confirm-scrim"]').trigger('click');
    expect(await backdropAnswer).toBe(false);

    const escapeAnswer = ask();
    await flushPromises();
    await wrapper.find('[data-test="confirm-scrim"]').trigger('keydown', { key: 'Escape' });
    expect(await escapeAnswer).toBe(false);
    expect(dialogState.open).toBe(false);
  });

  it('declines a question that a second one replaces', async () => {
    const wrapper = mount(ConfirmDialog, { global: testGlobal(), attachTo: document.body });
    const first = ask({ title: 'First' });
    const second = ask({ title: 'Second' });
    await flushPromises();
    expect(await first).toBe(false);
    expect(wrapper.find('[data-test="confirm-title"]').text()).toBe('Second');

    await wrapper.find('[data-test="confirm-ok"]').trigger('click');
    expect(await second).toBe(true);
  });
});
